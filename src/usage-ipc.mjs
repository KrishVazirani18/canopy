// Usage, host side: builds the Usage tab's state (src/core/usage.mjs) and Canopy's own count of spend
// (src/account-spend.mjs) from what main has, and gives the window its three calls. Thin on purpose: main says
// where the tools, the chats and the saved state are, and tells this file what chats report (`limit`, `chatEvent`).
//
// What is read is always the account in use, through that account's own launch environment (`accounts.envFor`):
// a chat that is already running on it when there is one, else a process started only to ask, which is never
// sent a message. Nothing here opens a login, and nothing runs while the tab is not on screen.
import { AccountSpend } from './account-spend.mjs';
import { engineOf } from './chats.mjs';
import { probeUsage } from './core/upkeep.mjs';
import { Usage, claudeSource, codexSource } from './core/usage.mjs';

const ENGINES = ['claude', 'codex'];
// The speed a Codex chat's turns ask for, in Codex's word for it ('priority' is Fast; null is standard): the price
// of a turn depends on it. A chat that cannot say ran at standard speed as far as anyone knows.
const tierOf = (session) => { try { const t = session?.tierFor?.(); return typeof t === 'string' && t ? t : null; } catch { return null; } };

/**
 * Wire the Usage tab and its IPC channels.
 * @param {(channel: string, fn: Function) => void} handle main's guarded `ipcMain.handle`
 * @param {{
 *   accounts: import('./core/accounts.mjs').Accounts,
 *   chats: () => (import('./chats.mjs').ChatHost | null),
 *   ready?: () => (Promise<unknown> | null),                the environment check, when it is still running
 *   claude: { query: Function, path: () => string | null, env?: () => object | null, version?: string, home?: () => string, probe?: Function, configDir?: () => string | undefined },
 *   codex?: { limits: () => Promise<object> },               CodexService.rateLimits()
 *   totals?: (sessionId: string, cwd: string | null) => Promise<{ cost?: number } | null>,   a chat's cost, as Stats counts it
 *   load: () => object | null | undefined, save: (state: object) => unknown,             state.json's `usage`
 *   loadSpend: () => object | null | undefined, saveSpend: (state: object) => unknown,   state.json's `accountSpend`
 *   send: (channel: string, payload: unknown) => void, log?: (msg: string) => void, onDrift?: (label: string, keys: string[]) => void,
 *   read?: object, now?: () => number, timers?: object,     test seams
 * }} host
 * @returns {{ usage: Usage, spend: AccountSpend, limit: Function, chatEvent: Function }}
 */
export function registerUsage(handle, { accounts, chats, ready, claude, codex, totals, load, save, loadSpend, saveSpend, send, log, onDrift, read, now, timers } = {}) {
  const say = (m) => { try { log?.(m); } catch { /* logging never breaks a read */ } };
  const host = () => { try { return chats?.() ?? null; } catch { return null; } };
  // The account a chat is on: the one it was started on, else the one its tool finds.
  const accountOf = (session) => accounts.resolve(engineOf(session), session?.accountId ?? null);
  const running = (engine, id) => host()?.liveOn?.(engine, (s) => accountOf(s) === id) ?? null;
  // The chat on screen, when it has started and runs on this account. (The panel is not shown beside Multi mode's panes.)
  const onScreen = (engine, id) => {
    const s = host()?.current?.session ?? null;
    return s && !s.closed && engineOf(s) === engine && typeof s.sessionId === 'string' && s.sessionId && accountOf(s) === id ? s : null;
  };

  const spend = new AccountSpend({
    load: loadSpend, save: saveSpend, defaultAccount: (engine) => accounts.resolve(engine, null), configDir: claude?.configDir, read, now,
    log: (m) => say(`spend: ${m}`),
  });

  // A process started only to ask, on the account in use. If another account became the one in use while this was
  // on its way, nothing is started: a new process would come up on that one and answer for the wrong account.
  const probe = async (id) => {
    if (accounts.view().inUse?.claude !== id) throw new Error('The account in use changed.');
    const claudePath = claude?.path?.() ?? null;
    if (!claudePath) throw new Error('Claude Code was not found.');
    const env = accounts.envFor('claude', { base: claude.env?.() ?? undefined });
    return (claude.probe ?? probeUsage)({ query: claude.query, claudePath, env, appVersion: claude.version, cwd: claude.home?.() });
  };

  const usage = new Usage({
    accounts: () => accounts.view(),
    sources: {
      claude: claudeSource({
        chat: (id) => running('claude', id),
        probe,
        dollars: (id) => spend.dollars(id),
        screen: (id) => onScreen('claude', id)?.sessionId ?? null,
        chatDollars: async (sessionId) => {
          const s = host()?.current?.session ?? null;
          return s?.sessionId === sessionId ? (await totals?.(sessionId, s.cwd ?? null))?.cost ?? null : null;
        },
      }),
      codex: codexSource({
        chat: (id) => running('codex', id),
        helper: () => (codex?.limits ? codex.limits() : Promise.resolve({ ok: false, code: 'not-installed' })),
        dollars: (id) => spend.codex(id),
        screen: (id) => onScreen('codex', id)?.sessionId ?? null,
        chatDollars: (threadId) => spend.codexChat(threadId),
      }),
    },
    load, save, onDrift, now, timers,
    onChange: (view) => send?.('usage:changed', view),
    log: say,
  });

  // The tab asks every few seconds while it is on screen (`open`: it has just come on screen). Main decides what is
  // stale enough to read again; the answer is always what is known right now.
  handle('usage:get', async (opts) => { await ready?.(); return usage.read({ open: opts?.open === true }); });
  // "Updated…" and Try Again.
  handle('usage:refresh', async (engine) => usage.refresh(ENGINES.includes(engine) ? engine : undefined));
  // The tab went away: nothing more is read.
  handle('usage:watch', async (on) => { usage.watch(on === true); return { ok: true }; });

  return {
    usage, spend,
    /** A limit update from a chat started on `pin` (null: whatever its tool finds): Claude's as Session hands it on, Codex's as it came. */
    limit(engine, pin, update) {
      try { usage.limit(engine, accounts.resolve(engine, pin ?? null), update); } catch (err) { say(`limit update: ${err?.message ?? err}`); }
    },
    /**
     * Every event of every chat, from the ChatHost: a process that started says which account its chat is on (for
     * the spend count), and a turn that ended has moved that account's numbers.
     * @param {object} ev @param {{ engine?: string, sessionId?: string | null } | null} entry the chat's status row @param {object | null} session
     */
    chatEvent(ev, entry, session) {
      try {
        if (ev?.kind !== 'init' && ev?.kind !== 'turn-end') return;
        const engine = session ? engineOf(session) : entry?.engine === 'codex' ? 'codex' : 'claude';
        const account = session ? accountOf(session) : accounts.resolve(engine, null);
        if (ev.kind === 'init') { if (engine === 'claude' && ev.sessionId) spend.started(ev.sessionId, account); return; }
        // A Codex turn says what it used and on which model; what that costs is worked out when it is read.
        if (engine === 'codex') { if (!ev.history) spend.addTurn(entry?.sessionId ?? ev.sessionId ?? null, account, { model: ev.model ?? null, tier: tierOf(session), usage: ev.turnUsage }); }
        else spend.settle(); // a day that ended while the app was open is counted now, not when the tab is next opened
        usage.turnEnded(engine, account);
      } catch (err) { say(`chat event: ${err?.message ?? err}`); }
    },
  };
}

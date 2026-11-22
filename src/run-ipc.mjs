// Run in the chat: a shell command from one of Claude's replies, run in a real terminal when you click Run.
//
// Claude can't run what needs a terminal of its own (a sign-in that opens the browser and waits, anything that asks a
// question), so it used to say "open the Terminal app and run …". A shell block in a reply now has a Run button
// (renderer/src/components/canopy/run-block.tsx): the command runs here, in a pseudo-terminal, in the chat's folder
// and under the chat's own account, and the window draws it as it prints. Nothing runs unless you click.
//
// The shell is yours as Terminal opens it (login and interactive, so your PATH, aliases and exported keys are there),
// started with `-c` on the command, so it ends when the command does.
//
// The window asks:
//   run:start  (id, { sid, cwd, code, cols, rows })  → { ok: true } | { error }
//   run:input  (id, data)          typing into it
//   run:resize (id, cols, rows)
//   run:stop   (id)                → { ok }   ends it (the shell and whatever it started)
// and is told:
//   run:data   ({ id, data })      what it printed, as it printed it
//   run:exit   ({ id, exitCode, signal })

const MAX_RUNS = 8;          // at once, across every chat
const MAX_CODE = 20_000;     // characters of one command
const COLS = [20, 400];
const ROWS = [2, 200];

const clamp = (n, [lo, hi], fallback) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback);

/**
 * @param {(channel: string, fn: Function) => void} handle main's guarded `ipcMain.handle`
 * @param {{
 *   on: (channel: string, fn: Function) => void,     main's guarded `ipcMain.on`
 *   send: (channel: string, ...args: unknown[]) => void,
 *   spawn: (file: string, args: string[], opts: object) => object,   node-pty's `spawn`
 *   chat: (sid: string) => ({ cwd?: string, engine?: string, accountId?: string | null } | null),
 *   env: (chat: object | null) => Record<string, string>,            the environment the chat's tool runs with (throws when its account can't be used)
 *   folder: () => string | null,                     the folder on screen, for a chat that has no process yet
 *   log?: (msg: string) => void,
 * }} host
 */
export function registerRuns(handle, { on, send, spawn, chat, env, folder, log }) {
  /** @type {Map<string, any>} id -> pty */
  const runs = new Map();
  const say = (msg) => { try { log?.(msg); } catch { /* never breaks a run */ } };

  handle('run:start', async (id, opts) => {
    if (typeof id !== 'string' || !id || id.length > 100) return { error: 'This run has no id.' };
    if (runs.has(id)) return { error: 'This is already running.' };
    const code = typeof opts?.code === 'string' ? opts.code.replace(/\s+$/, '') : '';
    if (!code.trim()) return { error: 'There is nothing to run.' };
    if (code.length > MAX_CODE) return { error: 'This command is too long to run from here.' };
    if (runs.size >= MAX_RUNS) return { error: `${MAX_RUNS} commands are already running. Stop one first.` };
    const c = typeof opts?.sid === 'string' ? chat(opts.sid) : null;
    // The chat's own folder when Canopy has it; the window's word for it otherwise (a chat that hasn't started yet).
    const cwd = c?.cwd || (typeof opts?.cwd === 'string' && opts.cwd.startsWith('/') ? opts.cwd : null) || folder();
    if (!cwd) return { error: 'Open a folder first.' };
    let base;
    try { base = env(c); } catch (err) { return { error: String(err?.message ?? err) }; }
    const shell = typeof base.SHELL === 'string' && base.SHELL.startsWith('/') ? base.SHELL : '/bin/zsh';
    let p;
    try {
      p = spawn(shell, ['-ilc', code], {
        name: 'xterm-256color', cwd,
        cols: clamp(opts?.cols, COLS, 100), rows: clamp(opts?.rows, ROWS, 12),
        env: { ...base, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
    } catch (err) {
      return { error: `Could not start ${shell}: ${String(err?.message ?? err)}` };
    }
    runs.set(id, p);
    say(`run ${id}: started in ${cwd}`);
    p.onData((data) => { if (runs.get(id) === p) send('run:data', { id, data }); });
    p.onExit(({ exitCode, signal }) => {
      if (runs.get(id) !== p) return;
      runs.delete(id);
      say(`run ${id}: exit ${exitCode}${signal ? ` (signal ${signal})` : ''}`);
      send('run:exit', { id, exitCode: Number.isInteger(exitCode) ? exitCode : null, signal: signal || null });
    });
    return { ok: true };
  });

  on('run:input', (id, data) => { if (typeof data === 'string') try { runs.get(id)?.write(data); } catch { /* it has ended */ } });
  on('run:resize', (id, cols, rows) => { try { runs.get(id)?.resize(clamp(cols, COLS, 100), clamp(rows, ROWS, 12)); } catch { /* it has ended */ } });
  handle('run:stop', async (id) => {
    const p = runs.get(id);
    if (!p) return { ok: false };
    // Hang up, as closing a Terminal window does: the shell passes it on to what it started. Still there a moment
    // later, it is killed. Its exit is reported as for any run.
    try { p.kill('SIGHUP'); } catch { /* already gone */ }
    const t = setTimeout(() => { if (runs.get(id) === p) try { p.kill('SIGKILL'); } catch { /* gone */ } }, 1500);
    t.unref?.();
    return { ok: true };
  });

  return {
    /** Ends every run (the app is quitting). */
    stopAll() { for (const p of runs.values()) try { p.kill('SIGHUP'); } catch { /* gone */ } runs.clear(); },
    get count() { return runs.size; },
  };
}

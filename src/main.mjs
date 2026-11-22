// Electron main process, and Canopy's composition root: it owns the window, the saved state and every IPC channel,
// and wires together the modules beside it. The engines themselves are in src/core. The sections, in order:
//
//   One instance, Log, Telemetry, Errors     what has to exist before anything can fail
//   Saved state                              state.json: one copy in memory, written through a temp file
//   Talking to the window                    Finder sheets, and the guard every channel goes through (handle, listen)
//   Environment check                        the login shell, Claude Code and Codex: found, their versions, signed in
//   Chats                                    the ChatHost with both engines' sessions, and what telemetry hears of them
//   Canopy's own tools                       look, screenshots, the relay a Codex chat calls them through, widget reports
//   Claude chats, Codex, Moving a chat, Models
//   Your Canopy account, Accounts, Usage, Sign-in
//   Opening a chat                           what session:open and pane:open share
//   IPC: launch and setup; Claude Code upkeep; Codex upkeep; Telemetry
//   IPC: folders, files, sessions, projects; the Dock badge; Tools; paths and pictures; the chat on screen;
//        Multi mode; Home and totals; the terminal view
//   Window                                   UI size, theme, links, the quit and restart questions, bounds, creation, menus
//   Restart                                  what every build runs to come back where it was
//   Dev                                      UI rebuilds and the engine-file poller: only when running from source
//   Start and quit
import { app, BrowserWindow, Menu, Notification, Tray, clipboard, desktopCapturer, dialog, ipcMain, nativeImage, nativeTheme, net, powerMonitor, safeStorage, screen, shell, systemPreferences } from 'electron';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSessions, getSessionInfo, getSessionMessages, renameSession, query } from '@anthropic-ai/claude-agent-sdk';
import { execFile, spawn } from 'node:child_process';
import { Session } from './core/session.mjs';
import { createShotStore, isShotRef } from './core/shots.mjs';
import { adaptHistory } from './core/adapter.mjs';
import { loadShellEnv, findClaude, claudeVersion, authStatus, configHome, gitInfo, gitState, listFiles, fullName, readUserPrefs } from './core/env.mjs';
import { registerCustomize } from './customize.mjs';
import { registerAccounts } from './accounts-ipc.mjs';
import { registerUsage } from './usage-ipc.mjs';
import { LOGIN_VARS } from './core/accounts-claude.mjs';
import { chatAccount, isFolderLogin, isPastedKey } from './core/accounts-codex.mjs';
import { folderEnv } from './core/accounts-codex-home.mjs';
import { registerCodexFolders } from './codex-account-folders.mjs';
import { refuse } from './core/accounts.mjs';
import { chatAccountLine, moveUnusedChats, registerAccountActions, recheckModels, restartChatsOn } from './account-actions.mjs';
import { Secrets } from './secrets.mjs';
import { CanopyAccount } from './canopy-account.mjs';
import { install as installTool } from './installers.mjs';
import { registerSignIn } from './signin-ipc.mjs';
import { registerRuns } from './run-ipc.mjs';
import { registerCodexSignIn } from './accounts-codex-ipc.mjs';
import { accountsRoot, registerAccountFolders } from './account-folders.mjs';
import { ChatHost, engineOf } from './chats.mjs';
import { CodexSession } from './core/codex-session.mjs';
import { CodexService, findCodex, codexVersion } from './core/codex-host.mjs';
import { CodexChats, engineFor } from './codex-chats.mjs';
import { CodexHeld, heldText } from './codex-held.mjs';
import { chatSources } from './core/read-chat.mjs';
import { ToolRelay } from './core/tool-relay.mjs';
import { MemoryStore } from './core/memory-store.mjs';
import { CodexListed } from './codex-listed.mjs';
import { CODEX_MIN_VERSION, CODEX_TOO_OLD, CODEX_UPDATES_OFF, codexTooOld, codexUpdatesOff, restartIdleCodex, updateCodex } from './core/codex-upkeep.mjs';
import { redact, makeRedactor } from './core/redact.mjs';
import { Handoffs, UNTITLED, sessionTitle } from './handoffs.mjs';
import { lastActive, lastPrompt, lastReply } from './last-active.mjs';
import { chatTotals } from './chat-totals.mjs';
import { chatCost } from './chat-cost.mjs';
import { rememberTools, startedWith, startsWithMemory } from './chat-tools.mjs';
import { dayActivity } from './day-activity.mjs';
import { searchChats } from './chat-search.mjs';
import { agentSteps, workflowAgents } from './workflows.mjs';
import { MenuBar } from './tray.mjs';
import { LAUNCH, pictureType, resolveClicked, safeExternal, wouldRun } from './open-rules.mjs';
import { createLookCapture } from './look-capture.mjs';
import { Upkeep, probeModels, versionText } from './core/upkeep.mjs';
import { ChatTitler, renameChat } from './chat-titles.mjs';
import { titleCase } from './title-case.mjs';
import { CodexTitler, titleHelper } from './codex-titles.mjs';
import { CodexTurnModels } from './codex-turn-models.mjs';
import { createComputerUse } from './computer-use.mjs';
import { createTelemetry } from './telemetry/index.mjs';
import { createEngineTracker } from './telemetry/engine.mjs';
import { createSummaryScheduler, summarizeDays } from './telemetry/summary.mjs';
import { AppUpdater, localFeed } from './core/app-update.mjs';
import { APP_ID, downloadUrl, feedUrl } from './app-info.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let win = null;
let envInfo = null;       // { env, claudePath, version, auth, shellOk, codexPath, codexVersion }
let current = null;       // the Session on screen (others keep running in the ChatHost)
let chats = null;         // ChatHost: every live chat, parallel
let currentCwd = null;
let term = null;          // node-pty process for the terminal view
let menuBar = null;       // the menu bar icon (src/tray.mjs)
let upkeep = null;        // keeps Claude Code current and its models at their newest (src/core/upkeep.mjs)
let codexUpkeep = null;   // the same class a second time, keeping the user's Codex current (src/core/codex-upkeep.mjs)

/** The window while there is one to act on, else null (not made yet, or closed). */
const liveWin = () => (win && !win.isDestroyed() ? win : null);

// Running from source? (app.isPackaged can't tell, because the dev bundle is renamed to Canopy.)
const IS_DEV = !app.getAppPath().includes('.asar') && existsSync(path.join(ROOT, 'vite.config.ts'));
// Usage stats from a copy run from source are kept apart in the charts; the released app's are "prod".
const TELEMETRY_ENV = IS_DEV ? 'dev' : 'prod';
// The packaged app checking itself (src/selftest.mjs), for the release script: only ever in an automated copy.
const SELFTEST = process.env.CANOPY_SELFTEST === '1' && !!process.env.CANOPY_USER_DATA;

// ---------- One instance ----------
app.setName('Canopy');
// For automated checks: a throwaway copy that leaves the user's Canopy alone. CANOPY_USER_DATA gives it
// its own data folder (the lock below is per folder); CANOPY_NO_WATCH=1 keeps it from rebuilding dist-ui.
if (process.env.CANOPY_USER_DATA) {
  const dir = path.resolve(process.env.CANOPY_USER_DATA);
  mkdirSync(dir, { recursive: true });
  app.setPath('userData', dir);
}
// The released app takes no debugger: only a copy run from source, or one under test (CANOPY_USER_DATA), can be driven from outside.
if (!IS_DEV && !process.env.CANOPY_USER_DATA) for (const s of ['remote-debugging-port', 'remote-debugging-pipe']) app.commandLine.removeSwitch(s);
// A second copy would fight the first over state.json, dist-ui and the open session.
const PRIMARY = app.requestSingleInstanceLock();

// ---------- Log ----------
// One line per event, in the app's data folder: dev.log when running from source, canopy.log otherwise.
// Writes are queued so lines land in order, and a failed write is dropped: logging never raises.
const logFile = () => path.join(app.getPath('userData'), IS_DEV ? 'dev.log' : 'canopy.log');
const pad = (n, w = 2) => String(n).padStart(w, '0');
const localStamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
let logWrites = Promise.resolve();
function log(msg) {
  const line = `${localStamp()} ${msg}\n`;
  logWrites = logWrites.then(() => appendFile(logFile(), line)).catch(() => {});
}
// At startup: past 1 MB, keep only the newest quarter.
function trimLog() {
  logWrites = logWrites.then(async () => {
    const file = logFile();
    await mkdir(path.dirname(file), { recursive: true });
    if ((await stat(file)).size <= 1024 * 1024) return;
    const tail = (await readFile(file, 'utf8')).slice(-256 * 1024);
    await writeFile(file, tail.slice(tail.indexOf('\n') + 1));
  }).catch(() => {});
}

// ---------- Telemetry (src/telemetry) ----------
// Usage stats, never content: what may be sent is listed in src/telemetry/schema.mjs, and nothing else leaves.
// Made here, before anything can fail, so the first error is already counted. It reads its files in the background
// (telemetry.init(), once this copy knows it is the one running); the window never waits for it, and nothing it does
// can throw into Canopy. In an automated run (CANOPY_USER_DATA) it records what it would send and sends nothing.
const telemetry = createTelemetry({
  dir: path.join(app.getPath('userData'), 'telemetry'),
  appVersion: app.getVersion(),
  osVersion: process.getSystemVersion?.() ?? 'unknown',
  env: TELEMETRY_ENV,
  // No name is handed in: one is sent only if the person types it in Settings > Privacy, never the Mac account's.
  log: (m) => log(`telemetry: ${m}`),
  // Active minutes: Canopy's window in front, and the Mac touched in the last two minutes.
  isFocused: () => !!liveWin()?.isFocused(),
  idleSeconds: () => powerMonitor.getSystemIdleTime(),
  // Folders an error's text may name. They are taken out by name: a folder with spaces in it has no shape to find.
  localPaths: () => [app.getPath('home'), currentCwd, ...(loadState().projects ?? [])],
});

// ---------- Errors ----------
function send(channel, ...args) {
  try { liveWin()?.webContents.send(channel, ...args); } catch {}
}

// Error toasts carry one plain line, and the same line at most once every 10 s (a failing timer would stack them).
const toasted = new Map(); // message -> when it was last shown
function notify(msg) {
  const now = Date.now();
  for (const [m, at] of toasted) if (now - at > 10_000) toasted.delete(m);
  if (toasted.has(msg)) return;
  toasted.set(msg, now);
  send('app:error', msg);
}

// Never let the main process die. Report instead: the first line to the UI, the full stack to the log.
function reportError(where, err) {
  console.error(`[canopy] ${where}`, err);
  log(`${where}: ${err?.stack ?? err}`);
  telemetry.error('main', err);
  notify(String(err?.message ?? err).split('\n')[0].slice(0, 300) || 'Something went wrong.');
}
process.on('uncaughtException', (err) => reportError('uncaught', err));
process.on('unhandledRejection', (err) => reportError('unhandled', err));

// ---------- Saved state (state.json) ----------
// Read once and kept in memory, so two saves can never drop each other's changes. Writes go one at a
// time through a temp file and a rename: a crash mid-write leaves the previous file, never half of one.
const statePath = () => path.join(app.getPath('userData'), 'state.json');
let stateCache = null;
let stateOnDisk = null;   // the JSON last read or written, so an unchanged save costs nothing
let stateWrites = Promise.resolve();
function loadState() {
  if (stateCache) return stateCache;
  stateCache = {};
  let raw = null;
  try { raw = readFileSync(statePath(), 'utf8'); } catch { /* first run: no file yet */ }
  if (raw !== null) {
    try {
      const s = JSON.parse(raw);
      if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('not an object');
      stateCache = s;
      stateOnDisk = raw;
    } catch {
      // Unreadable: keep a copy, rather than quietly replacing the project list with an empty one.
      try { copyFileSync(statePath(), `${statePath()}.bak`); } catch {}
    }
  }
  return stateCache;
}
function saveState(patch) {
  Object.assign(loadState(), patch);
  stateWrites = stateWrites.then(async () => {
    const json = JSON.stringify(stateCache, null, 2);
    if (json === stateOnDisk) return;
    const file = statePath();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, json);
    await rename(`${file}.tmp`, file);
    stateOnDisk = json;
  }).catch((err) => log(`state save failed: ${err?.message ?? err}`));
  return stateWrites;
}
// Queued writes (state.json, the log) reach the disk before we leave. Never waits more than 1.5 s.
const flushWrites = () => Promise.race([Promise.all([stateWrites, logWrites]), new Promise((r) => setTimeout(r, 1500))]);

// ---------- Talking to the window: Finder sheets, and the guard on every channel ----------
// Finder sheets: count the open ones, so a dev reload waits until they close (it would orphan the sheet).
let dialogOpen = 0;
async function pickDialog(opts) {
  dialogOpen++;
  try { return await dialog.showOpenDialog(win, opts); }
  finally { dialogOpen--; }
}

// Only Canopy's own page may call in: never a sub-frame, or anything else that ends up inside the window.
function fromApp(e) {
  if (!liveWin() || e.sender !== win.webContents) return false;
  const frame = e.senderFrame; // null once that page is gone
  return !!frame && frame.parent === null;
}

// Wrap every IPC handler so a bug returns an error object instead of throwing into the UI.
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!fromApp(e)) return { error: 'Not allowed.' };
    try { return await fn(...args); }
    catch (err) {
      console.error(`[canopy] ${channel}`, err);
      log(`${channel}: ${err?.stack ?? err}`);
      return { error: String(err?.message ?? err) };
    }
  });
}
// The same guard for the one-way channels (the window tells, and waits for no answer).
function listen(channel, fn) {
  ipcMain.on(channel, (e, ...args) => {
    if (!fromApp(e)) return;
    try { fn(...args); } catch (err) { reportError(channel, err); }
  });
}

// ---------- Environment check ----------
async function checkEnvironment(fresh) {
  // fresh ("Check again"): run the login shell again too, in case PATH changed since launch.
  const { env, shellOk } = await loadShellEnv(fresh ? { force: true } : undefined);
  // The user's own Codex, if they have one (the shell environment has CANOPY_* scrubbed out: the override goes back in).
  // Looked for alongside the Claude Code checks, so it adds nothing to the wait.
  const codexFound = findCodex({ ...env, CANOPY_CODEX_PATH: process.env.CANOPY_CODEX_PATH }).catch(() => null);
  const claudePath = await findClaude(env);
  const [version, auth] = claudePath
    ? await Promise.all([claudeVersion(claudePath, env), authStatus(claudePath, env)])
    : [null, { loggedIn: false }];
  const codexPath = await codexFound;
  envInfo = { env, claudePath, version, auth, shellOk, codexPath, codexVersion: envInfo?.codexPath === codexPath ? envInfo?.codexVersion ?? null : null };
  noteCodex(codexPath, env);
  noteSetup();
  codexHeld.start(); // behind everything else: nothing waits for it
  accounts.refresh({ auth: { claude: auth } }); // Accounts hears what this check found, so Claude Code is not asked twice
  return envInfo;
}
// Which Codex this is, for the log and for Codex upkeep. Asked in the background: nothing waits for it.
let codexNoted = null;
let codexVersionAsked = Promise.resolve(); // the question in flight (it never rejects), for telemetry's app_opened
function noteCodex(codexPath, env) {
  if (!codexPath) { if (codexNoted !== '') { codexNoted = ''; log('codex: not found'); } return; }
  codexVersionAsked = codexVersion(codexPath, env).then((v) => {
    if (envInfo?.codexPath === codexPath) envInfo = { ...envInfo, codexVersion: v };
    const line = `${codexPath} ${v ?? '(version unknown)'}`;
    if (codexNoted !== line) { codexNoted = line; log(`codex: ${line}`); }
  }).catch(() => {});
}
// Telemetry: getting started, step by step. Each step is reported the first time this install reaches it (telemetry
// remembers which were), so this is called wherever one may have just been reached.
function noteSetup() {
  if (envInfo?.claudePath) telemetry.milestone('claude_found');
  if (envInfo?.auth?.loggedIn === true) telemetry.milestone('claude_signed_in');
  if (envInfo?.codexPath) telemetry.milestone('codex_found');
  if (codexChats.signedIn === true) telemetry.milestone('codex_signed_in');
}
// Telemetry: app_opened says what this Mac has. It waits for the first environment check, for telemetry's own files
// and (a few seconds at most) for Codex to say its version; the window waits for none of them.
async function trackAppOpened() {
  await telemetry.init();
  await codexVersionAsked;
  const { claudePath, version, auth, codexPath, codexVersion: codexIs } = envInfo ?? {};
  telemetry.track('app_opened', {
    os_version: process.getSystemVersion?.(), arch: ['arm64', 'x64'].includes(process.arch) ? process.arch : 'other',
    cc_version: versionText(version), codex_version: codexIs,
    claude_found: !!claudePath, codex_found: !!codexPath,
    // Signed in or not is only said when it is known: "could not tell" must not read as "signed out".
    ...(typeof auth?.loggedIn === 'boolean' && { claude_signed_in: auth.loggedIn }),
    ...(typeof codexChats.signedIn === 'boolean' && { codex_signed_in: codexChats.signedIn }),
    first_run: telemetry.status().firstRun,
  });
}
// One check at a time. The window opens while the first one runs, and whoever asks meanwhile shares it.
let envCheck = null;
const ensureEnv = (fresh) => (envCheck ??= checkEnvironment(fresh).finally(() => { envCheck = null; }));

// The folders Claude Code and Codex keep their setup in: each tool's own variable moves it, as in the terminal.
// (`{}` before the shell has been read: the usual folder, never this process's own environment.)
const claudeDir = () => configHome(envInfo?.env ?? {});
const codexDir = () => envInfo?.env?.CODEX_HOME || path.join(app.getPath('home'), '.codex');

/** What Claude Code is on this Mac, for whoever launches it: its path and the shell's environment (null until found). */
const claudeTool = () => ({ path: envInfo?.claudePath ?? null, env: envInfo?.env ?? null });
/** A logger for a part that reports (level, message, data): one line of Canopy's log, under the part's name. */
const logAs = (name) => (level, msg, data) => log(`${name} ${level}: ${msg}${data ? ` ${JSON.stringify(data)}` : ''}`);
/** The open chat that holds a saved conversation, or null when it is not open. */
const liveChat = (sessionId) => chats?.manager.find({ sessionId })?.session ?? null;

function publicEnv() {
  const { claudePath, version, auth, shellOk, codexPath, codexVersion } = envInfo ?? {};
  return { claudePath, version, auth, shellOk, codexPath: codexPath ?? null, codexVersion: codexVersion ?? null };
}

// ---------- Chats: the ChatHost and both engines' sessions ----------
// Parallel chats: every chat stays live in the ChatHost; opening one switches what's on screen and never stops
// another (src/chats.mjs). Statuses, notifications and the Dock badge come from there too.
// `hostPrefs`: the user's saved terminal preferences that SDK sessions don't pick up on their own (Fast, bypass
// allowed, the default mode), read from Claude Code's settings.json each time a chat is opened (readUserPrefs).
let hostPrefs = {};
function chatHost() {
  if (chats) return chats;
  chats = new ChatHost({
    create: (o) => {
      // A Codex chat (src/core/codex-session.mjs): the same surface, the user's own `codex` underneath. `hostPrefs.fast`
      // is not applied: it mirrors the user's Claude Code config, and unset Fast in a Codex chat means their Codex config.
      if (o.engine === 'codex') {
        // The account the chat is on. A new chat takes the one in use now; a saved one goes back to the kind it
        // began on (Codex's own login, or a pasted key), because Codex opens a chat nowhere else. Its process is
        // started as that account is launched, at every start (`launchFor`): with nothing chosen, exactly as Codex
        // finds itself, and for a pasted key with the key in that process's own environment. A start that cannot
        // use the account fails instead of running on another login.
        const codex = new CodexSession({
          // A chat from the Codex app with no project is listed under Chats and still runs in its own folder.
          cwd: codexChats.folderOf(o.resume) ?? o.cwd, resume: o.resume, codexPath: () => envInfo?.codexPath ?? null, env: () => envInfo?.env,
          ...handoffs.sessionOpts(o), // { handoff } for a chat moved here from the other maker, else {}
          account: chatAccount({
            saved: !!o.resume, began: o.resume ? codexChats.accountOf(o.resume) : null, inUse: accounts.pin('codex'), isKey: (id) => !!codexKey(id),
            // A chat begun on a second login stays on it (and says its account is gone once that login is removed).
            beganOn: o.resume && isFolderLogin(accounts.get('codex', codexChats.accountOf(o.resume))) ? 'login' : null,
          }),
          launch: (base) => accounts.launchFor('codex', { account: codex.accountId, base }),
          accountNotice: (reported, id) => chatLine('codex', id, reported),
          // A chat another app has open is not started here (src/codex-held.mjs). When Codex itself refuses one
          // nobody was seen to hold, every process is looked at, so the window can say which app it is.
          heldElsewhere: (id, refused) => {
            const by = codexHeld.by(id);
            if (refused) codexHeld.refresh({ wide: !by });
            return by ? heldText(by.app) : refused ? heldText(null) : null;
          },
          allowBypass: !!hostPrefs.allowBypass, appVersion: app.getVersion(),
          // Canopy Kit (src/core/plugin.mjs): on unless turned off in Settings > General; read as the chat is made.
          canopyKit: kitOn(),
          // 'tasks': the chat's agents, listed for the agents drawer as a Claude chat's are.
          // 'elicitation': a question an MCP server asks mid-turn (a form, a sign-in link) is a card, not an automatic no.
          extended: ['tasks', 'elicitation'],
          // Canopy's own tools, the ones a Claude chat has below, reached through the relay (src/core/codex-tools.mjs).
          tools: toolRelay, look: lookCapture(), shots, otherChats,
          // How a widget's script ran, from the window, by the call's id: the same meeting place a Claude chat's uses.
          widgetReport: (callId) => widgetReports.wait(callId),
          // Canopy Memory (src/core/memory-store.mjs): the notes both makers' chats share, unless turned off in
          // Settings. A chat that is reopened has it or not as it started, whatever the switch says now.
          memory: startsWithMemory(loadState().chatTools, o.resume, memoryOn()) ? memory : null, memoryBridge: bridgeOn(),
          log: (level, msg, data) => { if (level !== 'debug') log(`codex ${level}: ${msg}${data ? ` ${JSON.stringify(data)}` : ''}`); },
          onDrift: (label, keys) => { log(`codex drift: ${label} ${JSON.stringify(keys ?? [])}`); codexUpkeep?.recordDrift(label, keys); },
          onRateLimits: (limits) => usage.limit('codex', codex.accountId, limits),
          onAccountUpdated: (info) => codexSignIn.accountUpdated(info),
        });
        return codex;
      }
      // A new chat takes the account in use now and keeps it: its environment is built again at each start, for
      // that same account, and a start that cannot use it fails instead of running on another login. The chat
      // itself says which account that is (`s.accountId`): until it has a conversation, a switch moves it too.
      // 'tasks': the live model of agents and background commands (with progress summaries) for the agents drawer.
      // 'task-stop': the drawer stops tasks one by one, so Claude Code's Stop may spare them (otherwise it kills them all).
      // 'elicitation': a question an MCP server asks mid-turn (a form, a sign-in link) is a card, as in an OpenAI chat.
      const pinned = startedWith(loadState().chatTools, o.resume);
      const s = new Session({
        ...o, claudePath: envInfo.claudePath, env: () => accounts.envFor('claude', { account: s.accountId }), account: accounts.pin('claude'), appVersion: app.getVersion(),
        allowBypass: !!hostPrefs.allowBypass, extended: ['tasks', 'task-stop', 'elicitation'],
        // Canopy Kit (src/core/plugin.mjs): on unless turned off in Settings > General; read as the chat is made.
        canopyKit: kitOn(),
        // A chat that is reopened gets the tools it started with, whatever the Code Mode switch says now.
        startedWith: pinned,
        // A chat moved here from the other maker: the old chat's digest, its name, and the folder its transcript is in.
        ...handoffs.sessionOpts(o),
        // Opening a folder as a project is trusting it: its chats load its project settings, hooks and MCP servers.
        trustedFolders: () => loadState().projects ?? [],
        // A chat on a sign-in Canopy keeps in a folder of its own: a folder you trusted in your own Claude Code counts there too.
        trustEnv: () => envInfo?.env ?? null,
        onDrift: (label, keys) => upkeep?.recordDrift(label, keys),
        onAccount: (reported, id) => accounts.reported('claude', id, reported),
        onRateLimit: (limit, id) => usage.limit('claude', id, limit),
        accountNotice: (reported, id) => chatLine('claude', id, reported),
        freeBackground: (sessionId) => freeBackground(sessionId, s.accountId),
        widgetReport: (toolUseId) => widgetReports.wait(toolUseId),
        look: lookCapture(),
        shots,
        otherChats,
        // Canopy Memory (src/core/memory-store.mjs): the notes both makers' chats share, unless turned off in
        // Settings. A chat that is reopened has it or not as it started, whatever the switch says now.
        memory: (pinned?.memory ?? memoryOn()) ? memory : null, memoryBridge: bridgeOn(),
      });
      if (hostPrefs.fast) s.settings.fast = true;
      return s;
    },
    send: (channel, payload) => send(channel, payload),
    notify: ({ title, body, onClick }) => {
      try {
        if (!Notification.isSupported()) return;
        const n = new Notification({ title, body });
        n.on('failed', (_e, err) => log(`notify failed: ${err}`)); // e.g. macOS hasn't allowed Canopy's notifications
        n.on('click', () => { showWindow(); onClick(); });
        n.show();
      } catch (err) { log(`notify: ${err?.message ?? err}`); }
    },
    badge: (n) => { if (!badgeFromWindow) setDockBadge(n); }, // until the window counts it (app:badge), which matches its sidebar
    isFocused: () => !!liveWin()?.isFocused(),
    isOnScreen: () => { const w = liveWin(); return !!w && w.isVisible() && !w.isMinimized(); },
    onEvent: (ev, entry) => {
      engineEvents.onEvent(ev, entry); // telemetry, first: it sees every event of both engines, and can't throw
      const codex = entry.engine === 'codex';
      usage.chatEvent(ev, entry, chats.manager.get(ev.sid)); // which account a chat runs on, and when its numbers moved
      if (ev.kind === 'init' && ev.sessionId && ev.sid === chats.activeSid) saveState({ lastFolder: entry.cwd, lastSession: ev.sessionId });
      // A Codex chat is listed and named from Canopy's own record of it; Claude Code's files know nothing about it.
      if (codex) codexChats.onEvent(ev, entry, chats.manager.get(ev.sid));
      // A chat OpenAI refused, or a reply after one: Accounts asks Codex who is signed in, or, for a chat on a pasted
      // key, asks OpenAI about that key.
      if (codex) codexSignIn.chatEvent(ev, codexKey(chats.manager.get(ev.sid)?.accountId));
      else if (ev.kind === 'meta') rememberClaudeModels(ev.models);
      // Once a chat has begun, what it started with (Code Mode in a Claude chat, Canopy Memory in either maker's) is
      // remembered for when it is reopened (chat-tools.mjs).
      if (ev.kind === 'init' || ev.kind === 'turn-end') {
        const chatTools = rememberTools(loadState().chatTools, entry.sessionId, chats.manager.get(ev.sid)?.startedWith);
        if (chatTools) saveState({ chatTools });
      }
      handoffs.onEvent(ev, entry); // a moved chat got its id: it is linked to the chat it continues, and takes its name
      if (!codex && (ev.kind === 'turn-end' || (ev.kind === 'init' && !entry.title)) && entry.sessionId) nameChat(entry.sessionId, entry.cwd);
      if (!codex && ev.kind === 'turn-end' && entry.sessionId) titler.afterTurn(chats.manager.get(ev.sid), entry.sessionId, entry.cwd);
      if (codex && ev.kind === 'turn-end' && entry.sessionId) codexTitler.afterTurn(entry.sessionId);
      // Codex keeps no model per turn, so each one is noted as it ends: a reopened chat's footers name theirs again.
      if (codex && ev.kind === 'turn-end' && entry.sessionId) turnModels.note(entry.sessionId, ev.turnId, ev.model);
      if (ev.kind === 'title') send('sessions:changed'); // Claude Code (re)named the chat: the sidebar and title bar re-read it now
      // A chat's first message was edited: its conversation started over under a new id, and the old one is not shown again.
      if (ev.kind === 'meta' && ev.supersedes) { supersede(ev.supersedes); send('sessions:changed'); }
      if (ev.kind === 'turn-end' && relaunchPending) setTimeout(maybeRelaunch, 300); // a restart was asked for: go once every chat is done
      // Claude Code is too old to start a chat: Canopy updates it rather than telling you to.
      if ((ev.kind === 'error' || ev.kind === 'notice') && ev.code === 'version') upkeep?.repair();
      signIn.chatEvent(ev, entry); // a turn that could not sign in: Claude Code is asked before anything says "signed out"
    },
    onStatus: (list) => { menuBar?.update(list); if (quitPending) setTimeout(maybeQuit, 300); if (requiredInstall) setTimeout(maybeInstallRequired, 300); },
    // Telemetry: something of the host's own was used (a notification clicked).
    onUsed: (name) => telemetry.track('feature_used', { name }),
    maxIdle: 8,
  });
  chats.manager.on('closed', ({ sid }) => engineEvents.onClose(sid));
  chats.manager.on('closed', ({ sid }) => handoffs.forget(sid)); // a moved chat let go before its first message
  return chats;
}
// Telemetry: what chats do, never what is said in them (src/telemetry/engine.mjs). The tracker follows every chat's
// events (the first line of onEvent above) and is told what only the handlers below know: a chat was opened, a
// message was sent or queued, a prompt was answered. From those it sends chat_started, message_sent, reply_finished,
// permission_answered, the first chat, message and reply, and a chat that broke. It also decides which conversations
// are Canopy's, for the daily summary to tell from the terminal's (the rule is in engine.mjs; telemetry keeps the list).
const engineEvents = createEngineTracker({
  track: telemetry.track, milestone: telemetry.milestone, error: telemetry.error, noteSession: telemetry.noteCanopySession,
  // A live chat as it stands, read straight off its session. Never through snapshot(): that flushes streamed text,
  // which would send events from inside the event being handled.
  describe: (sid) => {
    const s = chats?.manager.get(sid);
    if (!s) return null;
    const codex = engineOf(s) === 'codex';
    return {
      engine: codex ? 'codex' : 'claude',
      model: s.model ?? s.settings?.model ?? null,
      mode: s.mode ?? s.settings?.permissionMode ?? (codex ? 'default' : hostPrefs.defaultMode ?? 'default'),
      effort: (codex ? s.effortNow?.() : s.settings?.effort) ?? null,
      hasFolder: typeof s.cwd === 'string' && path.resolve(s.cwd) !== looseChatsDir(), // Canopy's own chats folder is "no project"
    };
  },
  isVisible: (sid) => !!chats && (sid === chats.activeSid || chats.shown.has(sid)),
  isEditing: (sid) => !!chats?.editing.has(sid),
});
// ---------- Canopy's own tools: look, screenshots, the relay, widget reports ----------
// Where the look tool gets its screenshots (src/look-capture.mjs): pages rendered in a window of Electron's own
// Chromium that is never shown, Canopy's windows from their own page, other apps' windows from the screen. One for
// every chat, Claude's and Codex's alike.
let looks = null;
function lookCapture() {
  looks ??= createLookCapture({ electron: { BrowserWindow, desktopCapturer, systemPreferences, nativeImage }, appName: app.getName(), log });
  return looks;
}
// Every picture look takes, kept per chat (src/core/shots.mjs) so a widget can show it again by its ref: look-1,
// look-2, … The newest 40 of each chat, on disk, so a chat reopened after a restart still shows them.
const shots = createShotStore({ dir: () => path.join(app.getPath('userData'), 'shots'), log });
// How a Codex chat calls Canopy's own tools (src/core/tool-relay.mjs): Codex starts a small helper for the chat, and
// the helper passes each call back here over a socket only this user can open. It listens from the first Codex chat on.
const toolRelay = new ToolRelay({ log: logAs('tool relay') });

// How drawing a widget went, from the window that drew it to the tool call that showed it (which tells Claude, so a
// script that failed is fixed in the same turn). The two meet here by tool-call id, whichever arrives first; a report
// nobody asks for, or a question nobody answers, is forgotten after a few seconds.
const widgetReports = {
  held: new Map(),    // id -> report, waiting to be asked for
  asked: new Map(),   // id -> resolve, waiting for the report
  wait(id) {
    if (this.held.has(id)) { const r = this.held.get(id); this.held.delete(id); return Promise.resolve(r); }
    return new Promise((resolve) => { this.asked.set(id, resolve); setTimeout(() => { if (this.asked.delete(id)) resolve(null); }, 5000); });
  },
  got(id, report) {
    const resolve = this.asked.get(id);
    if (resolve) { this.asked.delete(id); resolve(report); return; }
    this.held.set(id, report);
    setTimeout(() => this.held.delete(id), 5000);
  },
};
// A screenshot a widget shows (<canopy-shot ref>, <canopy-review ref>): only one the chat `sessionId` took itself.
handle('widget:shot', async (sessionId, ref) => {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128 || !isShotRef(ref)) return null;
  return shots.get(sessionId, ref);
});
handle('widget:report', async (toolUseId, report) => {
  if (typeof toolUseId !== 'string' || toolUseId.length > 100) return { ok: false };
  const errors = Array.isArray(report?.errors) ? report.errors.filter((e) => typeof e === 'string').slice(0, 5).map((e) => e.slice(0, 300)) : [];
  widgetReports.got(toolUseId, { errors });
  return { ok: true };
});

// ---------- Claude chats: freeing one a background session holds, and naming ----------
// A chat Claude Code won't open because one of its own background sessions still holds it. If that session has
// finished (only its entry is left), stop it so the chat opens here; if it's really working or waiting on someone,
// leave it. Canopy's own chats show up in that list too (with a live process), so those are never touched.
function freeBackground(sessionId, account) {
  // Asked with the chat's own login: Claude Code keeps its background sessions with the account they ran on.
  let env;
  try { env = accounts.envFor('claude', { account }); } catch { return Promise.resolve(false); }
  const claude = (args) => new Promise((resolve) => execFile(envInfo?.claudePath ?? 'claude', args, { env, timeout: 20000 },
    (err, out) => resolve(err ? null : String(out))));
  return claude(['agents', '--json', '--all']).then(async (out) => {
    let list = null;
    try { list = JSON.parse(out ?? ''); } catch { return false; }
    const items = Array.isArray(list) ? list : list?.sessions ?? list?.agents ?? [];
    const held = items.find((x) => x?.sessionId === sessionId);
    if (!held || held.pid || !['done', 'completed', 'stopped', 'failed', 'error'].includes(String(held.state ?? held.status))) return false;
    const ok = (await claude(['stop', held.id ?? sessionId])) != null;
    log(`background session ${String(held.id ?? sessionId).slice(0, 8)} (${held.state ?? held.status}) ${ok ? 'cleared so the chat can open' : 'could not be cleared'}`);
    return ok;
  });
}

// Names a chat from its first real exchange, with Claude Code's own titler (src/chat-titles.mjs).
const titler = new ChatTitler({
  log,
  onTitled: (sessionId, title) => { chats?.setTitle(sessionId, title); send('sessions:changed'); },
});
// The chat's name as Claude Code has it (custom title, else its summary), for notifications and the menu bar.
function nameChat(sessionId, cwd) {
  getSessionInfo(sessionId, cwd ? { dir: cwd } : undefined)
    .then((info) => { const t = info?.customTitle || info?.summary; if (t) chats?.setTitle(sessionId, t); })
    .catch(() => {});
}
const anyWorking = () => (chats?.workingCount() ?? 0) > 0 || !!current?.busy;

// ---------- Codex ----------
// GPT models run on the user's own Codex (src/core/codex-session.mjs). One shared helper process answers what belongs
// to no chat (the model list, a past chat's transcript, a rename); it starts on first use and goes a minute after its
// last call. Canopy keeps its own list of the Codex chats started here (src/codex-chats.mjs, state.json `codexChats`):
// that list is what says a saved chat is a Codex one. Without Codex on this Mac none of this starts anything.
// What every helper process is given: which Codex to start, in which environment, and how to keep secrets out of its log.
const codexServiceBase = Object.freeze({ codexPath: () => envInfo?.codexPath ?? null, env: () => envInfo?.env, appVersion: app.getVersion(), redact });
const codexService = new CodexService({ ...codexServiceBase, log: logAs('codex helper') });
// A second helper, for when the account OpenAI's new chats use is a key pasted into Canopy: started as that account
// is launched, it lists the models the key is offered. It starts only then, and goes when another account is chosen
// or the key is replaced (`switched`, `onRekeyed`). Everything about Codex's own login (who is signed in, signing
// in and out, a plan's limits) and about saved chats stays with the helper above, which is Codex as it finds itself.
const codexKeyService = new CodexService({
  ...codexServiceBase,
  launch: (base) => accounts.launchFor('codex', { base }),
  log: logAs('codex key helper'),
});
/** An account's id when it is a key pasted into Canopy, else null (null too for Codex's own login, and for none). */
const codexKey = (id) => (typeof id === 'string' && isPastedKey(accounts.get('codex', id)) ? id : null);
const codexChats = new CodexChats({
  load: () => loadState().codexChats, save: (list) => saveState({ codexChats: list }), service: codexService,
  keyService: codexKeyService, keyInUse: () => !!codexKey(accounts.pin('codex')),
  installed: () => !!envInfo?.codexPath, onChange: () => send('sessions:changed'), onModels: () => send('models:changed'), log,
});
// The chats Codex itself lists that Canopy did not start (the Codex app's, the terminal's), for your project folders
// and Codex's own project-less ones: src/codex-listed.mjs, state.json `codexListed`. `codexChats.has` is true for them too.
codexChats.listFrom(new CodexListed({
  load: () => loadState().codexListed, save: (list) => saveState({ codexListed: list }), service: codexService,
  folders: () => loadState().projects ?? [], home: () => app.getPath('home'), log,
}));
// Which Codex chats another app has open right now (src/codex-held.mjs): Codex lets one process write a chat, so
// such a chat is shown as open there and is not started here. Read when Codex's lock folder changes, when the window
// comes to the front and when a chat is opened; the window hears of every change. When a chat on screen is let go
// of, it is warmed up as any chat that has just been opened.
let heldIds = []; // the chats that were held at the last change
const codexHeld = new CodexHeld({
  dir: () => path.join(codexDir(), 'thread-writer-locks'),
  installed: () => !!envInfo?.codexPath,
  onChange: (held) => {
    send('codex:held', held);
    const freed = heldIds.filter((id) => !held[id]);
    heldIds = Object.keys(held);
    for (const s of shownChats()) { if (engineOf(s) === 'codex' && freed.includes(s.sessionId) && !s.q && !s.busy) warmUp(s); }
  },
  log,
});
app.on('browser-window-focus', () => codexHeld.refreshSoon());
// Names Codex chats as the Codex app does (src/codex-titles.mjs): once, after the first real exchange, never over yours.
const codexTitler = new CodexTitler({
  service: codexService, chats: codexChats, log,
  // The name is asked of a model on the chat's own account: a chat begun on a pasted key through that key's helper
  // (while that key is the one in use), never on Codex's own login.
  helperFor: (id) => titleHelper({ began: codexChats.accountOf(id), keyInUse: codexKey(accounts.pin('codex')), own: codexService, onKey: codexKeyService }),
  rename: (id, title) => codexChats.rename(id, title, liveChat(id), { by: 'canopy' }),
  onTitled: (id, title) => { chats?.setTitle(id, title); send('sessions:changed'); },
});
// Which model ran each turn of a Codex chat (src/codex-turn-models.mjs, state.json `codexTurnModels`).
const turnModels = new CodexTurnModels({ load: () => loadState().codexTurnModels, save: (all) => saveState({ codexTurnModels: all }) });
/** The engine of a chat about to open: a saved chat by Canopy's list, a new one by the model row that was picked. */
const engineToOpen = (resume, opts) => engineFor({ resume, engine: opts?.engine, has: (id) => codexChats.has(id), codexPath: envInfo?.codexPath, signedIn: codexChats.canStart });

// ---------- Moving a chat to the other maker ----------
// Picking the other maker's model in a started chat opens a new chat that carries on from it (src/handoffs.mjs). What
// is carried is built by plain code from the old chat (src/core/handoff.mjs): no model is asked, and nothing is sent
// until the new chat's first message.
const handoffs = new Handoffs({
  load: () => loadState().handoffs, save: (links) => saveState({ handoffs: links }),
  dir: () => path.join(app.getPath('userData'), 'handoffs'),
  historyOf: (id, cwd) => historyOf(id, cwd),
  chatOf: async (id, cwd) => {
    if (codexChats.has(id)) return { engine: 'codex', title: codexChats.titleOf(id) ?? '' };
    const title = sessionTitle(await getSessionInfo(id, cwd ? { dir: cwd } : undefined).catch(() => null));
    return { engine: 'claude', title: title === UNTITLED ? '' : title };
  },
  // A folder that is not a repo has no branch, and then nothing is said about it.
  gitState: (cwd) => gitState(cwd, envInfo?.env),
  // The new chat is named after the old one (a name of yours, so Canopy's own naming leaves it alone).
  rename: async ({ id, engine, cwd }, title) => {
    const session = liveChat(id);
    if (engine === 'codex') await codexChats.rename(id, title, session);
    else await renameChat(session, id, title, cwd, renameSession);
    chats?.setTitle(id, title);
    send('sessions:changed');
  },
  onChange: () => send('sessions:changed'),
  // The chat that was moved on from, if it is still open, is told so with its next message, should you go back to
  // it: work may have gone on in the new chat since (src/core/notes.mjs).
  onMoved: (rec) => { chats?.note(chats.manager.find({ sessionId: rec.from.id })?.sid, { kind: 'moved', model: rec.to.model }); },
  redact: (text) => makeRedactor(envInfo?.env)(text), log,
});
// A chat can be moved while nothing is running in it and nothing waits on you, except a plan Canopy itself is
// showing (plan with one maker, build with the other).
const movable = (session) => !session || (!session.busy && ![...(session.pending?.values?.() ?? [])].some((p) => !(p?.ev?.passive === true && p.ev.type === 'plan')));
/** `opts.move` on a new chat's open: the files are written and the key to them is handed on. Null: not a move. */
async function startMove(cwd, resume, opts) {
  const move = !resume && opts?.move && typeof opts.move === 'object' ? opts.move : null;
  if (!move) return null;
  const old = typeof move.from === 'string' ? liveChat(move.from) : null;
  const r = await handoffs.prepare(move, { cwd, busy: !movable(old), mode: old?.mode ?? old?.settings?.permissionMode ?? null, toEngine: engineToOpen(null, opts) });
  return r.ok ? { key: r.key } : { error: r.message };
}
// ---------- Models, and conversations an edit replaced ----------
// Claude's model rows as its chats last reported them, kept across restarts: a Codex chat never reports them, and the
// model picker lists both makers whichever chat is open.
let claudeModels = null;
const claudeModelRows = () => (claudeModels ??= Array.isArray(loadState().claudeModels) ? loadState().claudeModels : []);
function rememberClaudeModels(models) {
  if (!Array.isArray(models) || !models.length) return;
  let json = null;
  try { json = JSON.stringify(models); } catch { return; }
  if (json === JSON.stringify(claudeModelRows())) return;
  claudeModels = JSON.parse(json);
  saveState({ claudeModels });
  send('models:changed');
}
// The model picker's rows, by maker. `openai` is empty when Codex is missing, signed out or not answering: the picker
// then simply has no OpenAI group. Never an error, and after the first call never slower than memory.
// `codex` says what is known about Codex itself, for the status line in Settings > Models: installed, signed in, and
// how (`method`: 'apiKey' or 'chatgpt'). Never who: no email or plan leaves main. Whether it is signed in is Accounts'
// word once Accounts has one (a login OpenAI refused reads "not signed in" here as it does there).
handle('models:list', async () => {
  if (!envInfo) await ensureEnv();
  const { openai, codex } = await codexChats.models();
  noteSetup(); // Codex has just said whether it is signed in
  return { claude: claudeModelRows(), openai, codex: codexSignIn.describe({ ...codex, version: envInfo?.codexVersion ?? null, method: codexChats.signInMethod }) };
});

// Conversations replaced by an edit of their first message (nothing of them is kept, so the chat carries on in a new
// one). Their files stay on disk; they are just never listed or searched again, so the chat shows up once.
const superseded = () => new Set(loadState().superseded ?? []);
function supersede(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  saveState({ superseded: [...new Set([...(loadState().superseded ?? []), sessionId])].slice(-2000) });
}

// ---------- Your Canopy account ----------
// Canopy's own sign-in (Google, through Supabase; src/canopy-account.mjs), separate from Claude Code's and Codex's
// logins. Its session sits encrypted in a file of its own (the key vault below forgets anything that isn't an engine
// account's key); name, email and the photo's path sit in state.json. `onboarded` says the first run is behind you.
const canopyAccount = new CanopyAccount({
  store: new Secrets({ file: () => path.join(app.getPath('userData'), 'canopy-account.json'), safe: safeStorage, log: (m) => log(`canopy account: ${m}`) }),
  load: () => loadState().canopyAccount ?? null, save: (p) => saveState({ canopyAccount: p }),
  openExternal: (url) => shell.openExternal(url),
  avatarFile: () => path.join(app.getPath('userData'), 'account-photo.jpg'),
  appVersion: app.getVersion(),
  focusApp: () => { try { if (liveWin()) showWindow(); else app.focus({ steal: true }); } catch {} },
  onChange: (v) => send('canopyAccount:changed', v),
  log: (m) => log(`canopy account: ${m}`),
});
handle('canopyAccount:get', () => canopyAccount.view());
handle('canopyAccount:signIn', () => canopyAccount.signIn());
handle('canopyAccount:cancel', () => canopyAccount.cancel());
handle('canopyAccount:signOut', () => canopyAccount.signOut());
handle('canopyAccount:delete', () => canopyAccount.deleteAccount());
// Onboarding's Your Accounts: whether the Claude or ChatGPT desktop app is installed, which usually means a plan
// that Claude Code or Codex isn't signed in to yet. Only whether the app is there: its login is its own and is never
// read. Your Accounts then offers the tool's own sign-in, on the spot.
handle('setup:apps', () => {
  const has = (name) => [path.join('/Applications', name), path.join(app.getPath('home'), 'Applications', name)].some((p) => existsSync(p));
  return { claude: has('Claude.app'), chatgpt: has('ChatGPT.app') };
});
// The first run (onboarding, then the tour) shows once. CANOPY_ONBOARD=1 shows it again, for checking it. A Canopy
// that was already in use before onboarding existed (its state.json was there before this launch wrote anything)
// counts as onboarded: only a brand-new install sees it.
const usedBefore = existsSync(statePath()) && loadState().onboarded === undefined;
if (usedBefore) saveState({ onboarded: true });
handle('onboarding:get', () => ({ done: process.env.CANOPY_ONBOARD === '1' ? false : loadState().onboarded === true }));
handle('onboarding:done', () => { saveState({ onboarded: true }); return { ok: true }; });
// Canopy Kit's switch (Settings > General). It counts for chats made after it changes; open chats keep what they began with.
function kitOn() { return loadState().kit !== false; }
handle('kit:get', () => ({ on: kitOn() }));
handle('kit:set', (on) => { saveState({ kit: on === true }); return { on: kitOn() }; });

// ---------- Canopy Memory ----------
// Short notes a chat saves for the chats after it, shared by Claude and Codex chats (src/core/memory-store.mjs):
// plain Markdown files in the data folder's `memory`. A chat is shown the ones about you and its project when it
// starts and has three tools for the rest (src/core/memory-tools.mjs). The switch (Settings > You > Memory) is for
// new chats: a chat keeps what it began with for as long as it lives, reopened or not (chat-tools.mjs), because a
// tool that came or went mid-conversation would make the model re-read all of it at full price. Settings lists the
// notes, to edit or delete; the row a save or a removal leaves in a chat undoes it (remove, restore, or back to the
// wording before).
// A second switch is for the bridge: with it on, a Claude chat is also shown Codex's own memory summary and a Codex
// chat Claude Code's own memory indexes (src/core/memory.mjs). That sends what one maker's tool noted about you to
// the other maker's model. It is on unless you turn it off (Settings says so beside the switch): only a saved `false` counts.
const memory = new MemoryStore({ dir: () => path.join(app.getPath('userData'), 'memory') });
function memoryOn() { return loadState().memory !== false; }
function bridgeOn() { return loadState().memoryBridge !== false; }
const noteView = (n) => (n ? { id: n.id, title: n.title, text: n.text, scope: n.scope, project: n.project, source: n.source, engine: n.engine, created: n.created, updated: n.updated, replaced: n.replaced ?? null } : null);
handle('memory:get', () => ({ on: memoryOn(), bridge: bridgeOn() }));
handle('memory:set', (on) => { saveState({ memory: on === true }); return { on: memoryOn(), bridge: bridgeOn() }; });
handle('memory:bridge', (on) => { saveState({ memoryBridge: on === true }); return { on: memoryOn(), bridge: bridgeOn() }; });
handle('memory:list', () => ({ notes: memory.all().map(noteView), folder: memory.dir }));
handle('memory:state', (id) => { const s = memory.state(String(id ?? '')); return { note: noteView(s.note), removed: s.removed, previous: s.previous }; });
handle('memory:edit', (id, patch) => { const r = memory.edit(String(id ?? ''), patch); return r.error ? { error: r.error } : { note: noteView(r.note) }; });
handle('memory:remove', (id) => ({ ok: !!memory.remove(String(id ?? '')) }));
handle('memory:restore', (id) => ({ note: noteView(memory.restore(String(id ?? ''))) }));
handle('memory:revert', (id) => ({ note: noteView(memory.revert(String(id ?? ''))) }));

// ---------- Accounts ----------
// Which login each maker's chats are launched with (src/core/accounts.mjs): the ones Canopy found by asking Claude
// Code and Codex, and the one in use. Nothing chosen means the tool's own login, launched with nothing added.
// An API key pasted into Canopy is kept encrypted by the Keychain (src/secrets.mjs), never in state.json: the
// registry asks for it when a chat on that account is launched, and it goes nowhere else.
const secrets = new Secrets({ file: () => path.join(app.getPath('userData'), 'secrets.json'), safe: safeStorage, log: (m) => log(`secrets: ${m}`) });
// A Claude sign-in beside the one Claude Code holds lives in a folder of its own under ~/.canopy/accounts (a throwaway
// copy keeps its own, in its data folder). src/account-folders.mjs adds and removes them, puts each folder in order
// before anything is launched on it, and looks them all over at start and after each Claude Code update.
const chatsOn = (id) => (chats?.manager.sessions() ?? []).filter((s) => s.accountId === id && !s.closed);
// Where the sign-ins Canopy keeps beside each tool's own live: ~/.canopy/accounts, or the data folder of a throwaway copy.
const accountFoldersRoot = () => accountsRoot({ home: app.getPath('home'), userData: process.env.CANOPY_USER_DATA ? app.getPath('userData') : null });
const accountFolders = registerAccountFolders(handle, {
  accounts: () => accounts,
  root: accountFoldersRoot,
  claude: claudeTool,
  // Claude Code's own `claude auth login` for the new account's folder, in the window's sign-in sheet
  // (src/signin-ipc.mjs). It answers when the sheet is over: `ok` once Claude Code says who signed in to that
  // folder, else why not ('cancelled' when the sheet was closed). The account is already listed, signed out, so
  // the sign-in is told nothing about it but its folder. A plan is the default; the sheet itself can still switch
  // to the Console ("Use Console instead"), and what Claude Code then reports is what the account becomes.
  signIn: ({ dir, console: viaConsole }) => signIn.signIn({ dir, ...(viaConsole === true && { console: true }) }),
  // What runs on an account: a chat at work (or the terminal view on one of its chats, or Claude Code's sign-in
  // for it, which writes its folder), only idle chats, or nothing.
  inUse: (id) => (chatsOn(id).some((s) => s.working) || (!!term && (current?.accountId ?? null) === id) || signIn.runner.state?.account === id ? 'working'
    : chatsOn(id).some((s) => s.q || s.stopping) ? 'idle' : null),
  stopIdle: (id) => Promise.all(chatsOn(id).filter((s) => !s.working && s.q).map((s) => s.stop())),
  // The account new chats used is gone: they are back on the login Claude Code finds, like any other switch.
  onRemoved: (_id, was) => { if (was.active) switched('claude'); },
  // Listed in Settings like other changes in Claude Code, without a toast: nothing a chat was sent is being skipped.
  drift: (label, keys) => upkeep?.recordDrift(label, keys, { quiet: true }),
  log: (m) => log(`accounts: ${m}`),
});
// Second Codex logins (made below, once the registry exists): what the registry asks before launching one.
let codexFolders = null;
const accounts = registerAccounts(handle, {
  claude: claudeTool,
  claudeHome: accountFolders.guard,
  codex: {
    installed: () => !!envInfo?.codexPath, env: () => envInfo?.env ?? null, works: () => codexService.loginWorks(),
    // Asking Codex who is signed in is also when Canopy learns where the user's Codex keeps its folder: a second
    // login's processes keep their chat index there (src/codex-account-folders.mjs).
    account: () => { codexFolders?.learnHome(); return codexService.account(); },
    // A second Codex login (a folder of its own): put in order before every launch, and asked about in that folder.
    home: (account) => {
      if (!codexFolders) throw refuse('no-env', 'Canopy is still starting. Try again in a moment.', { recoverable: true });
      return codexFolders.guard(account);
    },
    checkLogin: (account) => (codexFolders ? codexFolders.verify(account) : Promise.resolve({ state: 'unknown' })),
  },
  load: () => loadState().accounts ?? null, save: (s) => saveState({ accounts: s }),
  send, log: (m) => log(`accounts: ${m}`),
  keyFor: (account) => secrets.get(account.id),
  checkKey: (account) => accountActions.verifyKey(account),
});
// Choosing the account new chats use, and adding, replacing and removing pasted keys (src/account-actions.mjs).
// A key is checked through Electron's network stack, so the Mac's proxy settings apply.
const accountActions = registerAccountActions(handle, {
  accounts, secrets, fetch: (url, init) => net.fetch(url, init), log: (m) => log(`accounts: ${m}`),
  // A login variable in Claude Code's own settings outranks whatever it is launched with, a pasted key included:
  // such a key is shown as not usable rather than letting its chats run, unseen, on the settings' login.
  outranked: (engine) => { if (engine !== 'claude') return false; const set = settingsEnv(); return LOGIN_VARS.some((name) => name in set); },
  onSwitch: (engine) => switched(engine),
  // A replaced key reaches the chats on its account at their next start, which is now for the idle ones.
  onRekeyed: (engine, id) => {
    restartChatsOn(chats?.manager.sessions(), id, engine);
    if (accounts.pin(engine) !== id) return;
    if (engine === 'codex') codexModelsChanged(); else recheckModels(upkeep);
  },
});
// The account an engine's new chats use changed: another was chosen, or the chosen one was removed.
// A switch is for new chats: a chat nobody has used yet moves too, a chat with a conversation never does.
// Models and Fast can differ by account (and by key), so the model check runs again. (The Connectors list is read
// as the account in use too: the window reads it again by itself when the accounts list says that changed.)
function switched(engine) {
  if (engine !== 'claude' && engine !== 'codex') return;
  moveUnusedChats(chats?.manager.sessions(), accounts.pin(engine), engine);
  // A new chat on screen that was held back because its login was gone (or that could not start on the account
  // before) starts ahead of its first message again, now that it is on an account that works.
  for (const s of shownChats()) { if (engineOf(s) === engine && !s.q && !s.sessionId && !s.busy) warmUp(s); }
  if (engine === 'codex') codexModelsChanged(); else recheckModels(upkeep);
}
// The account OpenAI's new chats use changed, or its key did: the helper started for the old one goes (it holds that
// key), and the model list is read again for the new one.
function codexModelsChanged() {
  codexKeyService.reset().catch(() => {});
  codexChats.forgetModels();
  send('models:changed');
}
// What a chat says about its account when it starts ("This chat uses Max."), when it is not the last chat's.
const chatLine = chatAccountLine({ accounts, load: () => loadState().chatAccount, save: (last) => saveState({ chatAccount: last }) });

// ---------- Usage ----------
// The right panel's Usage tab (src/core/usage.mjs): for the account in use, how much of its plan's limits is used,
// or what it has spent when it is billed per use (Canopy's own count, src/account-spend.mjs). Read through a chat
// that is already running when there is one, and only while the tab is on screen.
const usage = registerUsage(handle, {
  accounts, chats: () => chats, ready: () => (envInfo ? null : ensureEnv()),
  claude: { query, path: () => envInfo?.claudePath ?? null, env: () => claudeEnv(), version: app.getVersion(), home: () => app.getPath('home') },
  codex: { limits: () => codexLimits() },
  totals: (sessionId, cwd) => sessionTotals(cwd, sessionId),
  load: () => loadState().usage ?? null, save: (s) => saveState({ usage: s }),
  loadSpend: () => loadState().accountSpend ?? null, saveSpend: (s) => saveState({ accountSpend: s }),
  send, log: (m) => log(`usage: ${m}`), onDrift: (label, keys) => upkeep?.recordDrift(label, keys),
});
// ---------- Sign-in, commands run in a chat, and second Codex logins ----------
// Signing in again, and noticing a login that is gone (src/signin-ipc.mjs). The sign-in is Claude Code's own
// `claude auth login`, in a terminal in the window: Canopy passes the typing along and reads none of it.
const signIn = registerSignIn(handle, {
  accounts,
  claude: claudeTool,
  spawn: (file, args, opts) => require('node-pty').spawn(file, args, opts),
  on: listen,
  send, log: (m) => log(`accounts: ${m}`),
  sessions: () => ({ all: (chats?.manager.sessions() ?? []).filter((s) => engineOf(s) === 'claude'), shown: shownChats() }),
  ready: () => (envInfo ? null : ensureEnv()), auth: () => envInfo?.auth,
  // After a sign-in the whole check runs again, so nothing goes on saying "signed out". Models and Fast can differ
  // by login, so the model check runs again too, whatever it found before.
  recheck: async () => { await ensureEnv(); recheckModels(upkeep); },
  openFile: (file) => shell.openPath(file), tmp: () => app.getPath('temp'),
  onFocus: (fn) => app.on('browser-window-focus', fn),
  onPageGone: (fn) => app.on('web-contents-created', (_e, wc) => {
    wc.on('did-start-navigation', (d) => { if (wc === win?.webContents && d.isMainFrame && !d.isSameDocument) fn(); });
    wc.on('render-process-gone', () => { if (wc === win?.webContents) fn(); });
  }),
});
// Run in the chat (src/run-ipc.mjs): a shell block's Run button runs it in a terminal, in the chat's folder and under
// its account, so a `claude mcp login` there signs in the login the chat uses.
const runs = registerRuns(handle, {
  on: listen,
  send, spawn: (file, args, opts) => require('node-pty').spawn(file, args, opts),
  chat: (sid) => chats?.manager.get(sid) ?? null,
  env: (c) => (c ? accounts.envFor(engineOf(c), { account: c.accountId ?? null }) : accounts.envFor('claude')),
  folder: () => currentCwd,
  log: (m) => log(m),
});
// A chat is started ahead of its first message, unless its login is known to be gone: it would only start signed out.
const warmUp = (session) => { if (signIn.canWarm(session)) session.warm(); };
// The chats on screen: the main one, and any in Multi mode's panes.
const shownChats = () => [chats?.activeSid, ...(chats?.shown ?? [])].map((sid) => (sid ? chats.manager.get(sid) : null)).filter(Boolean);
// Signing in to Codex when it has no login, and out when the user says so (src/core/accounts-codex-login.mjs). The
// sign-in is Codex's own, in the user's browser; Canopy opens the page and asks Codex who is signed in afterwards.
// A second Codex login in a folder of its own: Settings → Codex → Add account → Sign in to Codex (src/codex-account-folders.mjs).
// Each of its helpers is pointed at its folder for the login and at the user's own Codex folder for the chat index, and
// is asked nothing until it says it started in that folder.
const codexFolderService = (dir) => new CodexService({
  ...codexServiceBase, home: dir,
  launch: (base) => ({ env: folderEnv({ dir }, base, { codexHome: codexFolders?.baseHome ?? null }), config: {} }),
  log: logAs('codex account helper'),
});
codexFolders = registerCodexFolders(handle, {
  accounts: () => accounts,
  root: accountFoldersRoot,
  codexHome: async () => { const r = await codexService.info(); return r?.ok ? r.codexHome : null; },
  service: codexFolderService, own: codexService, open: (url) => shell.openExternal(url),
  send, log: (m) => log(`accounts: codex ${m}`),
});
// The plan limits of a second Codex login while it is the one in use: read through a helper in its folder, never
// through Codex's own login (whose limits are another account's).
let inUseFolder = null; // { dir, service }
function codexLimits() {
  const a = accounts.get('codex', accounts.pin('codex'));
  if (!isFolderLogin(a)) return codexService.rateLimits();
  if (inUseFolder?.dir !== a.dir) { inUseFolder?.service.close().catch(() => {}); inUseFolder = { dir: a.dir, service: codexFolderService(a.dir) }; }
  return inUseFolder.service.rateLimits();
}

const codexSignIn = registerCodexSignIn(handle, {
  accounts, service: codexService, installed: () => !!envInfo?.codexPath, redact,
  open: (url) => shell.openExternal(url),
  // Another login is offered other models: what was read with the old one is asked for again.
  onLogin: () => { codexChats.forgetModels(); send('models:changed'); },
  // A chat on a pasted key was refused by OpenAI (or replied on a key listed as refused): the key is asked about.
  keyInDoubt: (id) => accountActions.keyInDoubt('codex', id),
  send, log: (m) => log(`accounts: codex ${m}`),
});

// ---------- Opening a chat ----------
// What a chat's read_chat tool (src/core/read-chat.mjs) can see of the other chats in its project, whichever maker's
// model the chat runs on. Claude Code's saved chats are read from disk; this adds what only the app knows: which
// chats are open and where each stands, the Codex chats started here, and the conversations an edit replaced.
const otherChats = chatSources({
  live: () => chats?.home() ?? [],
  codex: {
    rows: (dirs) => codexChats.rows(dirs),
    events: (id) => codexChats.history(id, { session: liveChat(id) }),
  },
  hidden: () => superseded(),
});

async function openSession(cwd, resume, opts) {
  closeTerm();
  hostPrefs = await readUserPrefs(envInfo?.env);
  const engine = engineToOpen(resume, opts);
  const r = await chatHost().open(cwd, resume, { ...(engine === 'codex' && { engine }), ...(opts?.handoffKey && { handoffKey: opts.handoffKey }) });
  if (!r.reused) engineEvents.onOpen({ sid: r.sid, kind: resume ? 'resumed' : 'new' });
  nameOpened(resume, engine, cwd);
  current = r.session;
  currentCwd = cwd;
  return r;
}
/** A reopened chat has no first message here to go by: it takes the name that is saved for it. */
function nameOpened(resume, engine, cwd) {
  if (resume && engine === 'codex') chats.setTitle(resume, codexChats.titleOf(resume));
  else if (resume) nameChat(resume, cwd);
}
/** What must hold before a chat is opened, on the main screen or in a pane: `{ error }` to answer with, else
 *  `{ moved }` (the key to a move's files when this open carries on from another maker's chat, else null). */
async function openChecks(cwd, resume, opts) {
  if (!envInfo?.claudePath) return { error: 'Claude Code is not installed.' };
  // Checked here: a missing folder otherwise fails inside the spawn and reads as "Claude Code could not start".
  if (!(await isDir(cwd))) return { error: `This folder no longer exists: ${cwd}` };
  const tooOld = codexGate(resume, opts); if (tooOld) return tooOld;
  const moved = await startMove(cwd, resume, opts);
  if (moved?.error) return moved; // refused (the old chat is working): nothing was opened, the old chat stays as it is
  return { moved };
}
/** What an open answers the window with, for the chat `r` that was opened or found still live. `heldAsk` is the
 *  question "is this Codex chat open in another app?", already on its way (heldCheck). */
async function openedReply(r, { cwd, resume, defaults, heldAsk }) {
  const engine = engineOf(r.session);
  if (r.reused) {
    // Still live (maybe mid-turn, maybe the chat on the main screen): hand back its state as it is, like a reattach,
    // instead of restarting it.
    const snap = { ...r.session.snapshot(), ...queueSnap(r.sid) };
    const history = await historyOf(snap.sessionId, cwd, r.sid);
    if (!snap.settings.permissionMode) snap.settings.permissionMode = defaults.mode;
    return { ok: true, sid: r.sid, reused: true, engine, live: { cwd, ...snap, engine, history }, defaults, held: await heldAsk };
  }
  const history = await historyOf(resume, cwd, r.sid);
  // Open in another app: its conversation is shown, and no Codex is started for it until it is let go of there.
  const held = await heldAsk;
  if (!held) warmUp(r.session);
  // `accountId`: the account the chat is on (null: the login its tool finds on its own), as a live chat's snapshot says it.
  return { ok: true, sid: r.sid, engine, accountId: r.session.accountId ?? null, history, defaults, held };
}

// ---------- IPC: launch and setup ----------
// Where "no project" sessions run: a private folder Canopy owns.
const looseChatsDir = () => path.join(app.getPath('userData'), 'chats');
async function chatsDir() {
  const dir = looseChatsDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

const isDir = async (p) => { try { return (await stat(p)).isDirectory(); } catch { return false; } };

handle('app:init', async () => {
  if (!envInfo) await ensureEnv();
  // A folder that has since been deleted is not offered again: the UI starts in the chats folder instead.
  const { lastFolder } = loadState();
  const { everSignedIn } = await signIn.atInit(); // signed out is only a full-screen stop when no login ever worked
  return {
    ...publicEnv(), lastFolder: lastFolder && await isDir(lastFolder) ? lastFolder : null,
    home: app.getPath('home'), userName: await fullName(), chatsDir: await chatsDir(),
    accounts: accounts.view(), everSignedIn,
    // For Settings: Canopy's own version and log, and the folders Claude Code and Codex keep their setup in (each tool's
    // own variable moves it, as in the terminal).
    appVersion: app.getVersion(), logFile: logFile(), dev: IS_DEV,
    claudeDir: claudeDir(), codexDir: codexDir(),
  };
});

handle('app:recheck', async () => { await ensureEnv(true); upkeep?.ensureModels(); return publicEnv(); });
// Onboarding's "Setting Things Up": installs a tool the environment check didn't find, with its maker's own installer
// (src/installers.mjs), then checks again so everything that waits on it sees it. Only for a tool that is missing.
let installing = null;
handle('setup:install', async (engine) => {
  if (engine !== 'claude' && engine !== 'codex') return { error: 'Not allowed.' };
  if (installing) return { error: 'Already installing.' };
  await ensureEnv();
  if ((engine === 'claude' ? envInfo?.claudePath : envInfo?.codexPath)) return { ok: true, env: publicEnv() };
  installing = installTool(engine, { env: envInfo?.env ?? process.env, log });
  try {
    const r = await installing;
    if (r.error) return r;
    await ensureEnv(true);
    const found = engine === 'claude' ? envInfo?.claudePath : envInfo?.codexPath;
    return found ? { ok: true, env: publicEnv() } : { error: 'Installed, but Canopy can’t find it yet. Restart Canopy.' };
  } finally { installing = null; }
});

// ---------- Claude Code upkeep ----------
// Canopy does the upkeep of Claude Code itself: updates it in the background (never while a chat is working), repairs
// one too old to start, offers each model family at its newest and notices frames it doesn't understand yet.
// The SDK names the Claude Code it was built against: anything older gets updated right away.
const ENGINE_CLAUDE = (() => {
  try { return JSON.parse(readFileSync(path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).claudeCodeVersion ?? null; }
  catch { return null; }
})();
// The `env` blocks of Claude Code's managed and user settings.json, which Claude Code applies to itself. Upkeep reads
// update opt-outs (DISABLE_AUTOUPDATER…) and privacy settings from there too. Re-read only when a file changes.
const settingsEnvCache = new Map(); // file -> { mtimeMs, env }
function settingsFileEnv(file) {
  try {
    const { mtimeMs } = statSync(file);
    const hit = settingsEnvCache.get(file);
    if (hit?.mtimeMs === mtimeMs) return hit.env;
    const e = JSON.parse(readFileSync(file, 'utf8'))?.env;
    const env = e && typeof e === 'object' ? Object.fromEntries(Object.entries(e).filter(([, v]) => typeof v === 'string')) : {};
    settingsEnvCache.set(file, { mtimeMs, env });
    return env;
  } catch { return {}; }
}
// What those two files set, managed over user, as in Claude Code.
function settingsEnv() {
  const dir = claudeDir();
  const managed = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json';
  return { ...settingsFileEnv(path.join(dir, 'settings.json')), ...settingsFileEnv(managed) };
}
function claudeEnv() {
  if (!envInfo?.env) return null;
  // Managed wins over user, user over the shell, as in Claude Code.
  return { ...envInfo.env, ...settingsEnv() };
}
// Telemetry: one 'upkeep' event per run of `claude update`. Upkeep reports a run by stamping status.lastCheck, so a
// new stamp is a new run: nothing newer ('check', current), a new version installed ('update', from -> to), or a run
// that failed ('check', failed, with the version still installed). Runs it put off or skipped are not runs.
let upkeepSeen = 0;
function noteUpkeep(status) {
  const check = status?.lastCheck;
  if (!check || !Number.isFinite(check.at) || check.at === upkeepSeen) return;
  upkeepSeen = check.at;
  const update = check.result === 'updated' && status.lastUpdate?.at === check.at ? status.lastUpdate : null;
  telemetry.track('upkeep', { action: update ? 'update' : 'check', result: check.result, from: update ? update.from : check.version, to: update?.to });
}
function startUpkeep() {
  if (upkeep || stopped || !envInfo) return;
  upkeepSeen = loadState().upkeep?.lastCheck?.at ?? 0; // the last run of an earlier launch was reported then
  upkeep = new Upkeep({
    claude: () => ({ path: envInfo?.claudePath ?? null, env: claudeEnv(), version: envInfo?.version ?? null }),
    // After an update: read the version again (the path stays the same; it's a link to the newest install).
    refreshVersion: async () => {
      if (!envInfo?.claudePath) return null;
      const v = await claudeVersion(envInfo.claudePath, envInfo.env);
      if (v && envInfo) envInfo = { ...envInfo, version: v };
      return envInfo?.version ?? null;
    },
    // Models and Fast can differ by account, so the probe is launched like a chat on the account in use.
    probe: ({ path: claudePath, env }) => probeModels({ query, claudePath, env: accounts.envFor('claude', { base: env }), cwd: app.getPath('home') }),
    isBusy: anyWorking,
    engineVersion: ENGINE_CLAUDE,
    load: () => loadState().upkeep ?? null,
    save: (s) => saveState({ upkeep: s }),
    // The version it reports at start, and each new one after an update, has the account folders looked over.
    onChange: (status, note) => { send('upkeep:status', { ...status, note, codex: codexStatus() }); accountFolders.onClaudeVersion(status.version); noteUpkeep(status); },
    log: (m) => log(`upkeep: ${m}`),
    // A throwaway copy (CANOPY_USER_DATA, for automated checks) never updates the real Claude Code on its own.
    schedule: !process.env.CANOPY_USER_DATA,
  });
  upkeep.start();
}

// ---------- Codex upkeep ----------
// The same care for the user's Codex, by the same Upkeep class a second time (src/core/codex-upkeep.mjs): kept current
// with Codex's own `codex update`, only while no chat of either maker is working; one too old for Canopy is updated
// rather than the user being asked to; what its app-server sends that Canopy does not know yet is listed in Settings.
let codexNoUpdates = false; // the user's own "do not check for updates" in their Codex settings, read once at start-up
/** Codex's half of the upkeep status: null without Codex on this Mac. */
const codexStatus = () => (envInfo?.codexPath && codexUpkeep ? codexUpkeep.status() : null);
/** What the window is told: Claude Code's status, with Codex's as `codex`. */
const upkeepStatus = () => (upkeep ? { ...upkeep.status(), codex: codexStatus() } : null);
// After an update: the path (a link the installer repoints, so it stays right; looked up again all the same) and the version.
async function refreshCodexVersion() {
  const env = envInfo?.env;
  if (!env) return null;
  const found = await findCodex({ ...env, CANOPY_CODEX_PATH: process.env.CANOPY_CODEX_PATH }).catch(() => null);
  const codexPath = found ?? envInfo?.codexPath ?? null;
  const v = codexPath ? await codexVersion(codexPath, env) : null;
  if (envInfo && codexPath) envInfo = { ...envInfo, codexPath, codexVersion: v ?? envInfo.codexVersion ?? null };
  return envInfo?.codexVersion ?? null;
}
function startCodexUpkeep() {
  if (codexUpkeep || stopped || !envInfo) return;
  codexUpkeep = new Upkeep({
    name: 'Codex',
    claude: () => ({ path: envInfo?.codexPath ?? null, env: envInfo?.env ?? null, version: envInfo?.codexVersion ?? null }),
    update: async (c) => {
      const r = await updateCodex({ codexPath: c.path, env: c.env });
      // From here on the new Codex: the shared helper and every idle Codex chat let their old process go (the next
      // message resumes the conversation). A chat that is working is never touched. A new Codex can list new models,
      // so its list is read again now rather than when the five minutes are up (and a release shows up at once).
      if (r.result === 'updated') {
        await restartIdleCodex({ service: codexService, sessions: () => chats?.manager.sessions() ?? [] });
        codexModelsChanged();
      }
      return r;
    },
    refreshVersion: refreshCodexVersion,
    blocked: () => (codexNoUpdates ? CODEX_UPDATES_OFF : null),
    isBusy: anyWorking, // a chat of either maker
    engineVersion: CODEX_MIN_VERSION,
    load: () => loadState().codexUpkeep ?? null,
    save: (s) => saveState({ codexUpkeep: s }),
    onChange: (status, note) => { if (upkeep) send('upkeep:status', { ...upkeep.status(), codex: envInfo?.codexPath ? { ...status, note } : null }); },
    log: (m) => log(`codex upkeep: ${m}`),
    // A throwaway copy (CANOPY_USER_DATA, for automated checks) never updates the real Codex on its own.
    schedule: !process.env.CANOPY_USER_DATA,
  });
  // Before the first check: the version (asked for in the background at launch, so it may not be in yet) and the user's own switch.
  Promise.all([envInfo.codexVersion || !envInfo.codexPath ? null : refreshCodexVersion(), envInfo.codexPath ? codexUpdatesOff(codexService) : false])
    .then(([, off]) => { codexNoUpdates = off === true; })
    .catch(() => {})
    .finally(() => { if (!stopped) codexUpkeep?.start(); });
}
/** A Codex too old for Canopy cannot open a chat: the reply says so, and it is updated now (at most once every 10 minutes). */
function codexGate(resume, opts) {
  if (engineToOpen(resume, opts) !== 'codex' || !codexTooOld(envInfo?.codexVersion)) return null;
  startCodexUpkeep();
  codexUpkeep?.repair().catch(() => {});
  return { error: CODEX_TOO_OLD };
}
// The window may ask before the environment check is done: wait for it, so the answer is never an empty one.
// `which`: 'codex' for Codex's switch, its "Check now" and its "Not shown yet" list; left out, Claude Code's.
handle('upkeep:status', async () => { if (!envInfo) await ensureEnv(); startUpkeep(); startCodexUpkeep(); return upkeepStatus(); });
handle('upkeep:check', async (which) => { await (which === 'codex' ? codexUpkeep : upkeep)?.update({ force: true, reason: 'manual' }); return upkeepStatus(); });
handle('upkeep:auto', async (on, which) => { (which === 'codex' ? codexUpkeep : upkeep)?.setAutoUpdate(on === true); return upkeepStatus(); });
handle('upkeep:clear-drift', async (which) => { (which === 'codex' ? codexUpkeep : upkeep)?.clearDrift(); return upkeepStatus(); });

// ---------- Canopy's own updates ----------
// Canopy keeps itself current as well (src/core/app-update.mjs): it reads a small feed on the newest GitHub release,
// downloads a newer version in the background, and installs it on "Restart to update" or when Canopy is next quit.
// A release can also be required: the window then shows "Update required" until it is installed.
// Never from source (there is no app to replace) and never in an automated run (CANOPY_USER_DATA), unless that run
// names a feed on this Mac to rehearse an update with: CANOPY_UPDATE_FEED=http://127.0.0.1:8765/latest.json. A
// rehearsal may also name the copy to replace (CANOPY_UPDATE_INSTALL_PATH); otherwise it is the app that is running.
const TEST_FEED = localFeed(process.env.CANOPY_UPDATE_FEED);
let requiredInstall = false; // "Update required" was answered: install as soon as it is downloaded and no chat is working
const appUpdate = new AppUpdater({
  current: app.getVersion(), bundleId: APP_ID, feedUrl: TEST_FEED ?? feedUrl(), sameFolder: !!TEST_FEED,
  dir: path.join(app.getPath('userData'), 'updates'), downloadUrl: downloadUrl(),
  // Canopy.app, from Canopy.app/Contents/MacOS/Canopy.
  appPath: (TEST_FEED && process.env.CANOPY_UPDATE_INSTALL_PATH) || path.resolve(process.execPath, '..', '..', '..'),
  fetch: (url, init) => net.fetch(url, init), // Chromium's network stack: the Mac's own proxy and certificates
  off: process.platform !== 'darwin' ? 'platform' : IS_DEV ? 'source' : process.env.CANOPY_USER_DATA && !TEST_FEED ? 'automated' : null,
  load: () => loadState().appUpdate ?? null,
  save: (s) => saveState({ appUpdate: s }),
  onChange: (status, note) => { send('app-update:status', { ...status, note: note ?? null }); if (requiredInstall) setTimeout(maybeInstallRequired, 0); },
  log: (m) => log(`update: ${m}`),
  ...(TEST_FEED && { firstCheckMs: 3000 }),
});
handle('app-update:status', async () => ({ ...appUpdate.status(), note: null }));
const updateStatus = (status) => ({ ...status, note: null });
handle('app-update:check', async () => updateStatus(await appUpdate.check({ manual: true })));       // Settings: Check for Updates
handle('app-update:download', async () => updateStatus(await appUpdate.check({ download: true }))); // with automatic updates off: download this one
handle('app-update:auto', async (on) => updateStatus(appUpdate.setAuto(on === true)));
// "Update required": download it if that has not happened yet, then install as soon as no chat is working. It never
// asks first: the window is covered until it is done, so a chat that waits for an answer cannot get one, and only
// chats that are really working are waited for. Installing is the same restart as any other (maybeRelaunch).
const reallyWorking = () => [...(chats?.status.values() ?? [])].some((e) => e.state === 'working' || (e.helpers || 0) > 0) || !!current?.busy;
function maybeInstallRequired() {
  if (!requiredInstall || !appUpdate.status().ready || relaunching) return;
  relaunchPending = true;
  maybeRelaunch(!reallyWorking());
}
handle('app-update:required', async () => {
  requiredInstall = true;
  // A check already under way may not have been one that downloads: ask once more when it left nothing ready.
  for (let i = 0; i < 2 && !appUpdate.status().ready && !appUpdate.status().error; i++) await appUpdate.check({ download: true });
  maybeInstallRequired();
  return { ...appUpdate.status(), note: null };
});
// "Not now" on a required update that could not be downloaded or installed: nothing waits for it any more.
handle('app-update:required-cancel', async () => { requiredInstall = false; return { ...appUpdate.status(), note: null }; });

// What Codex needs before it can use the Mac (src/computer-use.mjs), for Settings → Codex and for a failed step's
// "Open Settings". Reads through Codex's own calls; the panes it opens are a fixed list; `turn-on` is Codex's own
// config call and runs only when its button is clicked.
const computerUse = createComputerUse({
  service: codexService, codexHome: codexDir,
  openExternal: (url) => shell.openExternal(url),
  openApp: (bundleId) => new Promise((resolve, reject) => execFile('/usr/bin/open', ['-b', bundleId], { timeout: 5000 }, (err) => (err ? reject(err) : resolve()))),
  version: (plist) => new Promise((resolve) => execFile('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { timeout: 3000 }, (err, out) => resolve(err ? null : String(out).trim() || null))),
  log,
});
handle('computer-use:status', async () => { if (!envInfo) await ensureEnv(); return envInfo?.codexPath ? computerUse.status() : null; });
handle('computer-use:pane', async (key) => computerUse.openPane(String(key ?? '')));
handle('computer-use:turn-on', async () => { const r = await computerUse.turnOn(); return { ...r, status: await computerUse.status() }; });
handle('computer-use:codex-app', async () => computerUse.openCodexApp());

// ---------- Telemetry: what the window may ask ----------
// The window's own events (a feature used, a setting changed, a widget, a connector added) are checked here in the
// main process against the same allowlist as everything else, and those four kinds are all the window may send: an
// error, a day's counts or a milestone can only come from main itself. The Settings page reads the status, flips the
// switch, sets the name and lists what was sent; every change is pushed back on 'telemetry:status'. The first-launch
// notice says when it is on screen and when it has been answered.
handle('telemetry:track', async (event, props) => { telemetry.trackFromWindow(event, props); return { ok: true }; });
handle('telemetry:status', async () => { await telemetry.init(); return telemetry.status(); });
handle('telemetry:set', async (patch) => {
  if (typeof patch?.name === 'string') telemetry.setName(patch.name);
  if (typeof patch?.enabled === 'boolean') telemetry.setEnabled(patch.enabled);
  await telemetry.init();
  return telemetry.status();
});
handle('telemetry:recent', async () => telemetry.recent());
handle('telemetry:notice-shown', async () => { telemetry.markNoticeShown(); await telemetry.init(); return telemetry.status(); });
// The window has put the first-launch notice up. A new install sends nothing until that notice has been answered, or
// has been on screen for ten minutes of Canopy being open (telemetry counts them from here, across launches).
handle('telemetry:notice-up', async () => { telemetry.noticeOnScreen(); return { ok: true }; });
telemetry.onStatus((status) => send('telemetry:status', status));

// ---------- Telemetry: the daily summary ----------
// One `day_summary` per finished local day: how many messages went out from Canopy and from the other tools people
// use Claude Code and Codex in (the terminal, the desktop apps, editors), counted from the history both keep on this
// Mac (src/telemetry/summary.mjs). It is the number telemetry is for: is Canopy becoming where this person works.
// The reading happens in a process of its own at low priority, at most once an hour, and nothing of a chat comes
// back from it but counts. The first run also sends the 30 days before it.
const daySummary = createSummaryScheduler({
  track: telemetry.track, state: telemetry.state,
  // A day's event has an id made from the install and the date, so a day sent twice (a quit at the wrong instant) is stored once.
  installId: () => telemetry.status().installId,
  activeMinutesFor: (date) => telemetry.activeMinutes(date),
  installedAt: () => canopySince,
  // Sharing off, an automated run, or nowhere to send: nothing is read, and those days are not sent afterwards.
  enabled: () => telemetry.status().sending,
  // A day on which sharing was off is never sent, also once it is back on; and after sharing has been off at all,
  // neither is the month from before Canopy.
  offDays: () => telemetry.offDays(),
  summarize: ({ fromDate, toDate, signal }) => summarizeDays({
    fromDate, toDate, signal,
    // Every folder Claude Code may keep its history in on this Mac: its usual one, and the one the shell points it to.
    claudeDirs: [path.join(app.getPath('home'), '.claude'), envInfo?.env?.CLAUDE_CONFIG_DIR].filter(Boolean),
    codexHome: codexDir(),
    canopySessionIds: telemetry.canopySessions(),
    canopyChatsDir: looseChatsDir(),
    canopyBeforeIds: beforeTheList(),
    cacheFile: path.join(app.getPath('userData'), 'telemetry', 'summary-cache.json'),
  }),
  log: (m) => log(`telemetry: ${m}`),
});
// When Canopy first ran on this Mac (ms). For anyone who got Canopy with usage stats in it, that is telemetry's own
// first run. A Mac that had Canopy before then says so by the age of its data folder. Days before it are the summary's
// "before Canopy" baseline.
let canopySince = null;
async function findCanopySince() {
  const firstRun = Date.parse(telemetry.firstRunAt() ?? '');
  let made = NaN;
  try { made = (await stat(app.getPath('userData'))).birthtimeMs; } catch { /* no folder to ask */ }
  // A disk that keeps no creation time says 0, or a later time than the real one: only an earlier date is believed.
  canopySince = made > 0 && made < firstRun ? made : Number.isFinite(firstRun) ? firstRun : null;
}
// The stretch when Canopy was already in use here and not yet listing its conversations (the list began with usage
// stats): a chat it ran then is on no list, and is told by when it was written. Only a Mac that had Canopy before
// usage stats has such a stretch. On a first launch the data folder is made a moment before telemetry's files; that
// moment is not one. Both ends are saved once and never move: the summary's cache depends on them.
function beforeTheList() {
  const firstRun = Date.parse(telemetry.firstRunAt() ?? ''), until = Date.parse(telemetry.canopySessionsSince() ?? '');
  return canopySince && firstRun - canopySince > 60_000 && until > canopySince ? { from: canopySince, until } : undefined;
}

// ---------- IPC: folders, files, sessions, projects ----------
/** A project was opened: chats already open in it that were held back as untrusted start again, trusted. */
function projectsTrusted() {
  for (const s of chats?.manager.sessions() ?? []) { try { s.recheckTrust?.(); } catch (err) { log(`trust recheck: ${err?.message ?? err}`); } }
}

handle('folder:pick', async () => {
  const r = await pickDialog({ properties: ['openDirectory', 'createDirectory'] });
  const dir = r.filePaths[0];
  if (r.canceled || !dir) return null;
  await saveState({ lastFolder: dir, projects: [dir, ...(loadState().projects ?? []).filter((p) => p !== dir)] });
  projectsTrusted();
  return dir;
});

// "+" in the composer: native picker (fast, attached to the window). Images come back as data;
// other files come back as paths for @-mentions.
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
// An image is inlined up to about 5 MB once encoded for sending. A larger one goes as a path instead,
// and Claude Code reads it itself: nothing that size crosses to the page and back.
const MAX_IMAGE_BYTES = Math.floor(5 * 1024 * 1024 * 3 / 4);
handle('files:pick', async (cwd) => {
  // A chat with no project lives in Canopy's own (empty) chats folder: start where the user last was instead.
  const r = await pickDialog({ defaultPath: cwd && cwd !== (await chatsDir()) ? cwd : undefined, properties: ['openFile', 'multiSelections'] });
  if (r.canceled) return { images: [], paths: [] };
  const picked = await Promise.all(r.filePaths.map(async (f) => {
    const mediaType = IMAGE_TYPES[path.extname(f).slice(1).toLowerCase()];
    if (!mediaType) return { path: f };
    try {
      if ((await stat(f)).size > MAX_IMAGE_BYTES) return { path: f };
      return { image: { mediaType, data: (await readFile(f)).toString('base64'), name: path.basename(f) } };
    } catch { return { path: f }; }
  }));
  return { images: picked.flatMap((p) => (p.image ? [p.image] : [])), paths: picked.flatMap((p) => (p.path ? [p.path] : [])) };
});

/** Whether a chat's title is just its first message (whole or cut short with "…"). */
const samePrompt = (a, b) => {
  const n = (x) => String(x ?? '').replace(/…$/, '').replace(/\s+/g, ' ').trim();
  const x = n(a), y = n(b);
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x));
};

// All sessions across every project (or one project when cwd is given).
handle('sessions:list', async (cwd) => {
  const dirs = cwd ? [cwd] : [...new Set([...(loadState().projects ?? []), await chatsDir(), currentCwd].filter(Boolean))];
  const gone = superseded();
  const lists = await Promise.all(dirs.map((d) => listSessions({ dir: d, limit: 60 }).then((l) => l.filter((s) => !gone.has(s.sessionId)).map((s) => ({ ...s, cwd: d }))).catch(() => [])));
  // "updated" = when you last wrote to the chat, so the sidebar only reorders when you send something: never because a
  // chat in the background replied or finished. Before your first message lands, its last message, then the file's
  // mtime (which Claude Code bumps with bookkeeping when a background chat's process starts or stops; last-active.mjs).
  const claude = await Promise.all(lists.flat().map(async (s) => {
    // false: the title is still just your first message (the window waits for a name). Claude Code's first "summary" of a
    // new chat is that message itself (cut short), so it doesn't count.
    const named = !!(s.customTitle || (s.summary && !samePrompt(s.summary, s.firstPrompt)));
    return {
    id: s.sessionId,
    // never the digest a moved chat's first message carried. A name is shown in Title Case; your first message as you typed it.
    title: named ? titleCase(sessionTitle(s)) : sessionTitle(s),
    named,
    updated: (await lastPrompt(s.sessionId, s.cwd)) ?? (await lastActive(s.sessionId, s.cwd)) ?? s.lastModified, branch: s.gitBranch ?? null, cwd: s.cwd ?? null,
    preview: await lastReply(s.sessionId, s.cwd), // the sidebar's second line for a chat that isn't open
    };
  }));
  // Codex chats, from Canopy's own lists (the ones started here, and the ones Codex lists from its app and the terminal):
  // no process is asked, so they add nothing to the wait. A Codex chat with no project is listed under Chats.
  const codex = codexChats.rows(dirs, { chatsDir: await chatsDir() }).map((r) => (r.named === false ? r : { ...r, title: titleCase(r.title) }));
  return [...claude, ...codex];
});

// Projects: the folders the user opened, in their own order (state.json `projects`).
handle('projects:list', async () => loadState().projects ?? []);
// Your own order, from dragging projects in the sidebar. Only ever a new order of the saved folders: the list is
// also the folders that are trusted (a project is added through the folder picker), so a reorder cannot add one.
handle('projects:reorder', async (dirs) => {
  const have = loadState().projects ?? [];
  const order = (Array.isArray(dirs) ? dirs : []).filter((d) => have.includes(d));
  const projects = [...new Set([...order, ...have])];
  await saveState({ projects });
  return projects;
});
handle('projects:remove', async (dir) => {
  const projects = (loadState().projects ?? []).filter((p) => p !== dir);
  await saveState({ projects });
  return projects;
});

handle('session:rename', async (id, title, cwd) => {
  if (codexChats.has(id)) {
    const r = await codexChats.rename(id, title, liveChat(id));
    if (!r.ok) log(`codex rename: ${r.message ?? r.code}`); // Canopy's own list has the name either way
    chats?.setTitle(id, title);
    return { ok: true };
  }
  // The chat's running Claude Code, if any, must hear it: it would write its old name back over a name saved behind its back.
  await renameChat(liveChat(id), id, title, cwd, renameSession);
  chats?.setTitle(id, title); // notifications, Home and the menu bar use the new name too
  return { ok: true };
});
handle('session:mcp', async () => (current ? current.mcpStatus() : []));
// A folder's branch and origin (src/core/env.mjs): asked with the PATH of the user's shell (a Dock launch only has
// the system PATH, and with it a different git) and little else, and with any login taken out of the remote's address.
handle('git:info', (cwd) => gitInfo(cwd, envInfo?.env));
// ---------- The Dock badge, and what the window answers and tells one-way ----------
let restartAnswer = null;
// The page that was asked can no longer answer (it hung, crashed or reloaded): drop the question, so the next
// ⌘Q or close asks again instead of waiting on an answer that will never come.
const dropQuestion = () => { const a = restartAnswer; restartAnswer = null; a?.('cancel'); };
// The Dock badge: the window counts it from what its sidebar shows (chats waiting on you + unread ones); the host's own
// count is only a stand-in until the window has said.
let badgeFromWindow = false;
function setDockBadge(n) { try { app.dock?.setBadge(n > 0 ? String(n) : ''); } catch { /* no Dock */ } }
listen('app:badge', (n) => {
  if (!Number.isFinite(n)) return;
  badgeFromWindow = true;
  setDockBadge(Math.max(0, Math.floor(n)));
});
listen('app:restart-choice', (choice) => {
  if (!restartAnswer) return;
  const answer = restartAnswer; restartAnswer = null;
  answer(['wait', 'now', 'cancel'].includes(choice) ? choice : 'cancel');
});
listen('app:quit-cancel', () => { quitPending = false; });
// In every build, whatever the names say: the window asks for this state each time it loads, and a "Restart when
// done" picked from the Canopy menu waits here too. Only `ready` is from source alone (the dev poller sets it).
listen('dev:restart', () => { relaunchPending = true; maybeRelaunch(); });
// The Update ready card's state lives here, not in the window: a new UI build reloads the window, and the card (and a
// "Restart when done" already pressed) must come back as they were.
ipcMain.handle('dev:restart-state', (e) => (fromApp(e) ? { ready: engineUpdated, waiting: relaunchPending } : null));
ipcMain.on('dev:restart-cancel', (e) => { if (fromApp(e)) relaunchPending = false; });
// ---------- Tools: connectors, skills and plugins (src/customize.mjs) ----------
const customizeCtx = () => ({ claudePath: envInfo?.claudePath, env: envInfo?.env ?? process.env, cwd: currentCwd });
registerCustomize(handle, customizeCtx, {
  // Connector sign-ins are kept per account, so the list is read as the account new chats use. Changes are made in
  // your own Claude Code setup, and Canopy's account folders are brought in line straight after.
  readCtx: async () => {
    if (!envInfo?.env) return customizeCtx();
    await accountFolders.syncAll();
    try { return { ...customizeCtx(), env: accounts.envFor('claude') }; }
    catch { return customizeCtx(); } // the account in use cannot be launched: the list as your own setup has it
  },
  afterWrite: () => accountFolders.syncAll(),
});

// ---------- IPC: paths, pictures and previews from a chat ----------
// A click on a path must never run it (src/open-rules.mjs): what macOS would launch, install or mount is shown in
// Finder instead of being opened. Only main can ask macOS which app a file opens with.
const opensWith = { defaultAppName: (fileUrl) => app.getApplicationNameForProtocol(fileUrl) };

// "Open in Finder": a folder opens; a file (or an app bundle) is selected in its folder, never opened.
handle('shell:reveal', async (p) => {
  const st = await stat(p).catch(() => null);
  if (!st) return { ok: false, missing: p };
  if (!st.isDirectory() || LAUNCH.has(path.extname(p).toLowerCase())) { shell.showItemInFolder(p); return { ok: true }; }
  const err = await shell.openPath(p);
  return err ? { ok: false, error: err } : { ok: true };
});
// Clickable paths in replies: resolve against the chat's folder, then open (or show in Finder).
handle('path:open', async (p, cwd, reveal) => {
  const full = resolveClicked(p, cwd || currentCwd, app.getPath('home'));
  const st = await stat(full).catch(() => null);
  if (!st) return { ok: false, missing: full };
  if (reveal || await wouldRun(full, st, opensWith)) { shell.showItemInFolder(full); return { ok: true, path: full, revealed: true }; }
  const err = await shell.openPath(full);
  return err ? { ok: false, error: err } : { ok: true, path: full };
});

// A picture Claude or Codex looked at, for its step: { mediaType, data }, or { missing } when it is gone or is not a
// picture. The file's first bytes say what it is, never its name, so only a PNG, JPEG, GIF or WebP is ever handed over.
const MAX_VIEWED_BYTES = 20 * 1024 * 1024;
handle('image:read', async (p, cwd) => {
  if (!String(p ?? '')) return { missing: true };
  const full = resolveClicked(p, cwd || currentCwd, app.getPath('home'));
  const st = await stat(full).catch(() => null);
  if (!st?.isFile() || st.size > MAX_VIEWED_BYTES) return { missing: true };
  const bytes = await readFile(full).catch(() => null);
  const mediaType = bytes && pictureType(bytes);
  return mediaType ? { mediaType, data: bytes.toString('base64') } : { missing: true };
});

// A file's preview as Finder shows it (Quick Look: a PDF's first page, a document, a picture), for its attachment card.
// A PNG data URL, or null when there is none (a folder, a missing file, a kind Quick Look can't draw). Kept per path and
// modified time, so a card that re-renders doesn't ask again.
const thumbs = new Map(); // `${full}:${mtime}` -> data URL | null
handle('file:thumb', async (p, cwd) => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null;
  if (!String(p ?? '')) return null;
  const full = resolveClicked(p, cwd || currentCwd, app.getPath('home'));
  const st = await stat(full).catch(() => null);
  if (!st?.isFile()) return null;
  const key = `${full}:${st.mtimeMs}`;
  if (thumbs.has(key)) return thumbs.get(key);
  let url = null;
  try {
    const img = await nativeImage.createThumbnailFromPath(full, { width: 192, height: 192 });
    if (!img.isEmpty()) url = img.toDataURL();
  } catch { /* no preview for this kind */ }
  if (thumbs.size > 200) thumbs.delete(thumbs.keys().next().value);
  thumbs.set(key, url);
  return url;
});

handle('files:list', async (cwd) => listFiles(cwd, envInfo?.env ?? process.env));

// ---------- IPC: opening the chat on screen ----------
// `opts` (all optional): `engine: 'codex'` asks for a Codex chat when the chat is new (a saved chat keeps the engine
// it was started on); `replaceEmpty` lets go of the chat that was on screen if it was never used (picking the other
// maker's model in an empty chat swaps the chat instead of leaving a spare process behind); `move: { from, fromModel,
// toModel }` makes the new chat carry on from the chat `from` (the other maker's model was picked in a started chat).
// Every reply says which `engine` the chat really runs on: Claude when Codex was asked for but is not on this Mac.
handle('session:open', async (cwd, resume, opts) => {
  const checked = await openChecks(cwd, resume, opts);
  if (checked.error) return checked;
  const { moved } = checked;
  const before = opts?.replaceEmpty === true ? chats?.activeSid ?? null : null;
  const heldAsk = heldCheck(resume);
  // Remember exactly what's open (including "new, not sent yet") so a restart reopens it.
  saveState({ lastFolder: cwd, lastSession: resume || null, lastEngine: engineToOpen(resume, opts) });
  const r = await openSession(cwd, resume, moved ? { ...opts, handoffKey: moved.key } : opts);
  if (moved) handoffs.bind(moved.key, r.sid);
  if (before && before !== r.sid) chats.discardIfUntouched(before);
  return openedReply(r, { cwd, resume, defaults: { mode: hostPrefs.defaultMode ?? 'default' }, heldAsk });
});
// Is the Codex chat about to be opened open in another app? Asked while its conversation is read, so opening waits
// for nothing more: { app, line, text } (as `codex:held` gives it), or null for any other chat.
async function heldCheck(resume) {
  if (!resume || !codexChats.has(resume)) return null;
  await codexHeld.fresh();
  return codexHeld.all()[resume] ?? null;
}
handle('codex:held', async () => codexHeld.all());

// ---------- Multi mode: chats in panes ----------
// Each pane holds its own chat, addressed by its id (sid), so the main screen's chat (`current`) stays as it was.
// Events for every chat in a pane reach the window (ChatHost.shown); the panes route them by sid.
// A chat's waiting messages, for the snapshot the window redraws from.
const queueSnap = (sid) => { const q = chats?.queueOf(sid) ?? { queue: [], v: 0 }; return { queue: q.queue, queueV: q.v }; };
const paneChat = (sid) => (typeof sid === 'string' ? chats?.manager.get(sid) ?? null : null);
// What a chat opens with, as events, for either engine: its saved transcript, the notes a restart left in it, and its
// "Continued from / Continued in" lines (`sid`: the open chat, for one that was moved here and has no id yet, so its
// line is there before its first message). Never throws: a failure is one notice in the list.
async function historyOf(sessionId, cwd, sid) {
  let events = [];
  if (sessionId && codexChats.has(sessionId)) {
    // A Codex chat: its own live process if it has one (it knows about a turn in flight), else the shared helper.
    events = turnModels.stamp(sessionId, await codexChats.history(sessionId, { session: liveChat(sessionId) }));
  } else if (sessionId) {
    try { events = adaptHistory(await getSessionMessages(sessionId, { dir: cwd })); }
    catch (err) { events = [{ kind: 'notice', level: 'warn', text: `Could not load history: ${err?.message ?? err}` }]; }
  }
  return handoffs.notes({ sessionId, sid }, sessionId ? withRestartNotes(sessionId, events) : events);
}
// `opts` as for session:open, with `replace` (the sid of the chat this pane held) in place of `replaceEmpty`.
handle('pane:open', async (cwd, resume, opts) => {
  const checked = await openChecks(cwd, resume, opts);
  if (checked.error) return checked;
  const { moved } = checked;
  hostPrefs = await readUserPrefs(envInfo?.env);
  const asked = engineToOpen(resume, opts);
  const r = await chatHost().openPane(cwd, resume, { ...(asked === 'codex' && { engine: asked }), ...(moved && { handoffKey: moved.key }) });
  if (!r.reused) engineEvents.onOpen({ sid: r.sid, kind: resume ? 'resumed' : 'new' });
  if (moved) handoffs.bind(moved.key, r.sid);
  nameOpened(resume, engineOf(r.session), cwd);
  if (typeof opts?.replace === 'string' && opts.replace !== r.sid) chats.discardIfUntouched(opts.replace, { pane: true });
  return openedReply(r, { cwd, resume, defaults: { mode: hostPrefs.defaultMode ?? 'default' }, heldAsk: heldCheck(resume) });
});
handle('pane:shown', async (sids, cached) => { chats?.setShown(Array.isArray(sids) ? sids : [], Array.isArray(cached) ? cached : undefined); return { ok: true }; });
handle('pane:send', async (sid, text, images, id) => {
  const s = paneChat(sid);
  if (!s) return { error: 'This chat isn’t open anymore.' };
  const sent = s.send(text, images ?? [], sendId(id));
  chats?.noteSentTo(sid, text);
  if (sent?.ok !== false) engineEvents.onSend({ sid, text, images }); // telemetry: the engine took it
  return { ok: true };
});
handle('pane:edit', async (sid, o) => editChat(typeof sid === 'string' ? sid : null, o));
handle('pane:edit-preview', async (sid, messageId) => (typeof sid === 'string' ? chats?.editPreview(sid, messageId) : null) ?? null);
handle('pane:queue', async (sid, text, images) => queueMessage(sid, text, images) ?? { error: 'This chat isn’t open anymore.' });
handle('pane:unqueue', async (sid, id) => chats?.queueRemove(sid, id) ?? { ok: false, removed: false, queue: [], v: 0 });
handle('pane:requeue', async (sid, id, to) => chats?.queueMove(sid, id, to) ?? { ok: false, moved: false, queue: [], v: 0 });
handle('pane:interrupt', async (sid) => { await paneChat(sid)?.interrupt(); return { ok: true }; });
handle('pane:set', async (sid, key, value) => { await paneChat(sid)?.set(key, value); return { ok: true }; });
handle('pane:respond', async (sid, id, answer) => { engineEvents.onPermissionAnswer({ sid, id, answer }); paneChat(sid)?.respond(id, answer); return { ok: true }; });
handle('pane:context', async (sid) => paneChat(sid)?.contextUsage() ?? null);
handle('pane:earlier', async (sid, sessionId, cwd, cursor) => earlierOf(sessionId || paneChat(sid)?.sessionId, cursor));
handle('pane:task-stop', async (sid, taskId) => paneChat(sid)?.stopTask(taskId) ?? { ok: false });

// ---------- IPC: the chat on screen (reattach, send, edit, queue), Home, totals ----------
// UI reloaded (Cmd+R): reattach to the running session without restarting it.
handle('session:attach', async () => {
  // The page that showed the terminal is gone, and the new one doesn't know about it. Stop that
  // Claude Code before ours starts again: only one process may drive a session.
  closeTerm();
  if ((!current || !currentCwd) && process.env.CANOPY_REOPEN) {
    // We were relaunched by the dev watcher: reopen where we were.
    delete process.env.CANOPY_REOPEN;
    const { lastFolder, lastSession } = loadState();
    if (lastFolder && envInfo?.claudePath) {
      // The folder may have been deleted meanwhile: come back in the chats folder rather than fail.
      // A new chat that had not started comes back on the engine it was on.
      const again = { engine: loadState().lastEngine };
      if (await isDir(lastFolder)) await openSession(lastFolder, lastSession ?? null, again);
      else await openSession(await chatsDir(), null, again);
    }
  }
  if (!current || !currentCwd) return null;
  if (!current.q && !current.closed) warmUp(current); // UI reloaded: make sure commands arrive
  return liveSnapshot();
});
// The chat on screen as the engine has it right now: its state and its saved conversation.
async function liveSnapshot() {
  if (!current || !currentCwd) return null;
  const snap = { ...current.snapshot(), ...queueSnap(chats?.activeSid) };
  const history = await historyOf(snap.sessionId, currentCwd, chats?.activeSid);
  const prefs = await readUserPrefs(envInfo?.env);
  if (!snap.settings.permissionMode) snap.settings.permissionMode = prefs.defaultMode ?? 'default';
  return { cwd: currentCwd, sid: chats?.activeSid ?? null, ...snap, engine: engineOf(current), history };
}
// An edit that didn't go through: the window shows the chat as it really is again. Unlike attach, nothing is
// restarted or closed for it.
handle('session:snapshot', liveSnapshot);

// A send carries the id the window gave its message (a uuid), so the bubble knows which saved message it is and can
// be edited later. Anything else is left out and the engine makes one up.
const sendId = (id) => (typeof id === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? { id } : {});
handle('session:send', async (text, images, id) => {
  if (!current) return { error: 'No session open.' };
  const sent = current.send(text, images ?? [], sendId(id));
  chats?.noteSent(text);
  if (sent?.ok !== false) engineEvents.onSend({ sid: chats?.activeSid, text, images }); // telemetry: the engine took it
  return { ok: true };
});
// Edit and resend (src/chats.mjs; core's Session.edit, or CodexSession.edit in an OpenAI chat): the message and
// everything after it go, and the new text is answered instead. The window passes only what it may: which message,
// the new words, and whether to put files back too (Claude chats only: Codex keeps nothing to put them back from).
async function editChat(sid, o) {
  if (!sid || !chats) return { ok: false, message: 'No session open.' };
  // The terminal view has this conversation right now, and only one process may drive it.
  if (term && sid === chats.activeSid) return { ok: false, code: 'parked', message: 'Close the terminal to edit a message here.' };
  const r = await chats.edit(sid, {
    messageId: o?.messageId, text: o?.text, restoreFiles: o?.restoreFiles === true, ...sendId(o?.id),
    ...(Array.isArray(o?.images) && { images: o.images }),
  });
  // The chat's first message was replaced: a name Canopy gave it described the old one, so it is worked out again.
  // An OpenAI chat goes by its first message until it is named: one still called after the old words follows the new.
  if (r?.ok && r.first) {
    const sessionId = chats.manager.get(sid)?.sessionId;
    if (sessionId && codexChats.has(sessionId)) { codexChats.firstMessageEdited(sessionId, r.replaced, o?.text); codexTitler.again(sessionId); }
    else titler.again(sessionId);
  }
  if (r?.ok) engineEvents.onSend({ sid, text: o?.text, images: o?.images }); // telemetry: an edited message is a message sent
  return r;
}
handle('session:edit', async (o) => editChat(chats?.activeSid ?? null, o));
handle('session:edit-preview', async (messageId) => (chats?.activeSid ? chats.editPreview(chats.activeSid, messageId) : null) ?? null);
// A message typed while the chat works waits in main (src/chats.mjs) and goes out when its turn ends. Telemetry
// counts it now, as queued: when it goes out later, nothing here hears of it again.
function queueMessage(sid, text, images) {
  const r = chats?.queueAdd(sid, text, images ?? []);
  if (r?.ok) engineEvents.onSend({ sid, text, images, queued: true });
  return r;
}
handle('session:queue', async (text, images) => (chats?.activeSid ? queueMessage(chats.activeSid, text, images) : null) ?? { error: 'No session open.' });
handle('session:unqueue', async (id) => chats?.queueRemove(chats.activeSid, id) ?? { ok: false, removed: false, queue: [], v: 0 });
handle('session:requeue', async (id, to) => chats?.queueMove(chats.activeSid, id, to) ?? { ok: false, moved: false, queue: [], v: 0 });
// ⌘K: search what was said inside every chat (your projects and the loose-chats folder).
handle('chats:search', async (query) => searchChats(query, [...(loadState().projects ?? []), await chatsDir(), currentCwd], { skip: superseded() }));
// A reloaded window asks for every chat's status (the sidebar spinners), since it only hears changes after that.
handle('chats:list', async () => chats?.statusList() ?? []);
// Home: every chat's live status, and acting on any chat from there (answer its question, stop it).
handle('home:list', async () => chats?.home() ?? []);
// Today in quarter hours for Home's strip: working time, cost and chats from the transcripts, plus what's running now.
function today() {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const extra = (chats?.home() ?? []).flatMap((c) => (c.spans ?? []).filter((x) => x.kind === 'work' && c.sessionId).map((x) => ({ chat: c.sessionId, from: x.from, to: x.to })));
  return dayActivity({ since: since.getTime(), extra });
}
handle('home:day', today);
handle('home:respond', async (sid, id, answer) => { engineEvents.onPermissionAnswer({ sid, id, answer }); return chats?.respond(sid, id, answer) ?? { ok: false }; });
handle('home:stop', async (sid) => chats?.stop(sid) ?? { ok: false });
handle('home:stop-tasks', async (sid, ids) => chats?.stopTasks(sid, ids) ?? { ok: false });
handle('session:interrupt', async () => { await current?.interrupt(); return { ok: true }; });
handle('session:set', async (key, value) => { await current?.set(key, value); return { ok: true }; });
handle('session:respond', async (id, answer) => { engineEvents.onPermissionAnswer({ sid: chats?.activeSid, id, answer }); current?.respond(id, answer); return { ok: true }; });
handle('session:context', async () => (current ? current.contextUsage() : null));
// "Show earlier": the turns just older than the ones a very long chat opened with: { events } or { error }. Only an
// OpenAI chat has any (Codex hands a long chat out in pages); a Claude chat is always read whole, so it answers
// { events: [] }. `cwd` is not needed to find a chat by its id: it is in the call for a reader that will be.
async function earlierOf(sessionId, cursor) { return codexChats.earlier(sessionId, { session: liveChat(sessionId), cursor }); }
handle('session:earlier', async (sessionId, cwd, cursor) => earlierOf(sessionId || current?.sessionId, cursor));
// A chat's lifetime cost, working time and lines changed (Claude Code keeps them in the transcript).
async function sessionTotals(cwd, sessionId) {
  const id = sessionId || current?.sessionId;
  // A Codex chat: what its live process has reported, and nothing from Claude Code's files (they do not know it).
  // Codex reports no cost, so that stays zero and Stats leaves it out.
  if (sessionId ? codexChats.has(sessionId) : engineOf(current) === 'codex') {
    const live = id ? chats?.totals(id) ?? null : null;
    return live ? { linesAdded: 0, linesRemoved: 0, cost: live.cost ?? 0, agentCost: 0, workMs: live.workMs ?? 0 } : null;
  }
  // Claude Code's saved totals cover earlier runs; the live tally covers this run, even while the chat was off screen.
  // Cost: Claude Code's numbers miss agents that outlive a turn (workflows), so the transcript tally (chat + every
  // agent, priced per reply) is counted too, and the largest wins (Claude Code's own also has small side calls).
  const [file, live, priced] = await Promise.all([chatTotals(id, cwd || currentCwd), chats?.totals(id) ?? null, chatCost(id, cwd || currentCwd).catch(() => null)]);
  if (!file && !live && !priced) return null;
  return { ...(file ?? { linesAdded: 0, linesRemoved: 0 }), cost: Math.max(file?.cost ?? 0, live?.cost ?? 0, priced?.total ?? 0), agentCost: priced?.agents ?? 0, workMs: Math.max(file?.workMs ?? 0, live?.workMs ?? 0) };
}
handle('session:totals', sessionTotals);
// (A Codex chat has no workflows: Claude Code's files would be searched for an id they do not hold.)
handle('workflow:agents', async (cwd, sessionId) => ((sessionId ? codexChats.has(sessionId) : engineOf(current) === 'codex') ? null : workflowAgents(cwd || currentCwd, sessionId || current?.sessionId)));
handle('agent:steps', async (cwd, sessionId, agentId) => agentSteps(cwd || currentCwd, sessionId || current?.sessionId, agentId));
handle('session:task-stop', async (taskId) => (current ? current.stopTask(taskId) : { ok: false }));

// ---------- Terminal fallback: the real Claude Code TUI for the same session ----------
function closeTerm() {
  if (term) { try { term.kill(); } catch {} term = null; }
}

handle('term:open', async (cols, rows) => {
  if (!currentCwd) return { error: 'Open a folder first.' };
  // The terminal runs Claude Code on the chat's id: a Codex chat's id means nothing to it.
  if (engineOf(current) === 'codex') return { error: 'The terminal view works in Claude chats.' };
  // The terminal carries on this chat, so it runs on the chat's own login. Worked out first: if that account cannot
  // be used, the chat is left running instead of being stopped for a terminal that will not open.
  const env = accounts.envFor('claude', { account: current ? current.accountId ?? null : undefined });
  const pty = require('node-pty');
  const sessionId = current?.sessionId ?? null;
  current?.stop(); // only one process may drive a session at a time
  closeTerm();
  const args = sessionId ? ['--resume', sessionId] : [];
  term = pty.spawn(envInfo.claudePath, args, {
    name: 'xterm-256color', cols: cols || 100, rows: rows || 30, cwd: currentCwd,
    env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  const t = term;
  t.onData((d) => { if (term === t) send('term:data', d); });
  t.onExit(({ exitCode }) => { if (term === t) { term = null; send('term:exit', { exitCode, sessionId }); signIn.terminalClosed(); } });
  signIn.terminalOpened(); // you may sign in or out in there: Claude Code is asked again when it closes
  return { ok: true, sessionId };
});
listen('term:input', (data) => { try { term?.write(data); } catch {} });
listen('term:resize', (cols, rows) => { try { term?.resize(cols, rows); } catch {} });
handle('term:close', async () => { closeTerm(); signIn.terminalClosed(); return { ok: true }; });

// ---------- Window: where its files are, and its size ----------
const ICON = path.join(ROOT, 'assets', 'icon.png');
const UI_INDEX = path.join(ROOT, 'dist-ui', 'index.html');
const WIN_SIZE = { width: 1320, height: 880 };
const WIN_MIN = { width: 820, height: 520 };

// ---------- UI size (View ▸ Zoom In / Zoom Out / Actual Size) ----------
// The page draws at UI_BASE × the chosen size, so "100%" is a step larger than the CSS's own pixels
// (the CSS's own size is now 90%). Chromium zoom leaves the traffic lights alone, so they, the sheet
// offset and the minimum window size are recomputed to match the zoomed 44px toolbar.
const UI_BASE = 1 / 0.9;
const UI_SIZES = [80, 90, 100, 110, 120, 130, 140, 150]; // below 80% the lights run into the toolbar's 84px inset
const uiSize = () => { const s = loadState().uiSize; return UI_SIZES.includes(s) ? s : 100; };
const uiFactor = () => (UI_BASE * uiSize()) / 100;
const lightsAt = (f) => ({ x: Math.round(16 * f), y: Math.round(22 * f - 7) }); // 14px buttons centered in the 44px bar
function applyUiSize() {
  if (!liveWin()) return;
  const f = uiFactor();
  win.webContents.setZoomFactor(f);
  if (process.platform === 'darwin') win.setWindowButtonPosition(lightsAt(f));
  win.setSheetOffset(Math.round(44 * f));
  // Keep the layout's minimum (820×520 in CSS px) at any size, but never larger than the screen.
  const area = screen.getDisplayMatching(win.getBounds()).workAreaSize;
  const min = { width: Math.min(Math.round(WIN_MIN.width * f), area.width), height: Math.min(Math.round(WIN_MIN.height * f), area.height) };
  win.setMinimumSize(min.width, min.height);
  if (!win.isFullScreen() && !win.isMaximized()) {
    const [w, h] = win.getSize();
    if (w < min.width || h < min.height) win.setSize(Math.max(w, min.width), Math.max(h, min.height));
  }
}
function stepUiSize(dir) {
  const i = UI_SIZES.indexOf(uiSize());
  const next = dir === 0 ? 100 : UI_SIZES[Math.max(0, Math.min(UI_SIZES.length - 1, i + dir))];
  if (next === uiSize()) return;
  saveState({ uiSize: next });
  telemetry.track('setting_changed', { key: 'ui_size', value: String(next) }); // a percentage: 80 to 150
  applyUiSize();
  setAppMenu(); // Zoom In / Out grey out at the ends
}

// ---------- Theme, links, and the quit and restart questions ----------
// Appearance follows Canopy's own theme setting (renderer index.html), so the vibrancy material matches it.
handle('app:theme', async (pref) => { if (['system', 'light', 'dark'].includes(pref)) nativeTheme.themeSource = pref; return { ok: true }; });

// Links open in the browser, and only web and mail links: a reply must not be able to hand macOS a
// shortcuts://, ssh:// or file:// URL to act on.
function openExternalSafe(url) {
  const href = safeExternal(url);
  if (href) { try { shell.openExternal(href).catch(() => {}); } catch { /* nothing to open it with */ } }
}

let startConfirmed = false; // the window has loaded once (see did-finish-load)
// Runs the packaged app's checks of itself, prints what they found and exits with their verdict.
async function selfTest() {
  let code = 1;
  try {
    const { runSelfTest } = await import('./selftest.mjs');
    code = await runSelfTest({ app, Menu, win, isDev: IS_DEV, telemetryEnv: TELEMETRY_ENV, logFile: logFile(), engineClaude: ENGINE_CLAUDE, update: appUpdate.status().off ?? 'on' });
  } catch (err) { console.error(`self-test could not run: ${err?.stack ?? err}`); }
  shutdown();
  await flushWrites();
  app.exit(code);
}
let quitting = false;   // quitting for certain: the window closes without asking
function quitNow() { quitting = true; app.quit(); }
let quitPending = false; // "Quit when done": quit as soon as nothing is working
let uiHung = false;      // the page stopped responding: it can't answer a question
let closeAsked = 0;      // when the window was last told to close (a close that then hangs is finished off, not asked about)
function maybeQuit() { if (quitPending && !anyWorking()) quitNow(); }

/**
 * Chats are working and you asked to quit or restart: wait for them, go now, or cancel. Asked in Canopy's own dialog
 * (the window answers on app:restart-choice), naming the chats it would stop; the macOS one only when the window
 * can't answer (it never loaded, or it hangs).
 * @param {'quit'|'restart'} kind
 * @returns {Promise<'wait'|'now'|'cancel'>}
 */
async function askWhileWorking(kind) {
  // Each chat a restart or quit would cut off, and where it stands: working (or helpers still running), or waiting
  // for you (it won't finish until you answer, so "when done" includes your answer).
  const going = [...(chats?.status.values() ?? [])].filter((e) => e.state === 'working' || e.state === 'needs-you' || (e.helpers || 0) > 0)
    .map((e) => ({ title: e.title || (e.cwd ? path.basename(e.cwd) : 'A chat'), helpers: e.helpers || 0,
      state: e.state === 'needs-you' && !(e.helpers > 0) ? 'waiting' : 'working' }));
  // The chat on screen can be busy a moment before its status says so.
  if (!going.length) going.push({ title: 'A chat', helpers: 0, state: 'working' });
  const working = going.filter((g) => g.state === 'working').length;
  if (liveWin() && !loadFailed && !uiHung && !win.webContents.isCrashed()) {
    dropQuestion(); // a newer question replaces one still open
    return new Promise((resolve) => { restartAnswer = resolve; send('app:restart-ask', { kind, busy: going.length, names: going }); });
  }
  // The window can't ask (it failed to load or hung): the same question as a macOS alert.
  const verb = kind === 'quit' ? 'Quit' : 'Restart';
  const message = `${verb} Canopy?`;
  if (!working) {
    const { response } = await dialog.showMessageBox(...[liveWin()].filter(Boolean), {
      type: 'question', message, detail: going.length === 1 ? 'A chat is waiting for you. It picks up where you left off.' : `${going.length} chats are waiting for you. They pick up where you left off.`,
      buttons: [verb, 'Cancel'], defaultId: 0, cancelId: 1 });
    return response === 0 ? 'now' : 'cancel';
  }
  const { response } = await dialog.showMessageBox(...[liveWin()].filter(Boolean), {
    type: 'question', message,
    detail: `${going.length === 1 ? 'A chat is still working' : `${going.length} chats are still going`}. ${verb === 'Quit' ? 'Quitting' : 'Restarting'} now stops ${going.length === 1 ? 'it' : 'them'} mid-step.`,
    buttons: [`${verb} When Done`, `${verb} Now`, 'Cancel'], defaultId: 0, cancelId: 2 });
  return ['wait', 'now', 'cancel'][response];
}

// ---------- Window: bounds, creation, the menu bar and the app menu ----------
// Where the window was last time, as long as enough of its title strip is on a connected display to grab.
function savedBounds() {
  const b = loadState().window;
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  for (const { workArea: a } of screen.getAllDisplays()) {
    if (Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x) < 120 || b.y < a.y - 1 || b.y + 44 > a.y + a.height) continue;
    return {
      x: Math.round(b.x), y: Math.round(b.y),
      width: Math.round(Math.min(Math.max(b.width, WIN_MIN.width), a.width)), height: Math.round(Math.min(Math.max(b.height, WIN_MIN.height), a.height)),
    };
  }
  return null;
}
function saveBounds() {
  if (!liveWin()) return;
  const fullscreen = win.isFullScreen();
  // Full screen or minimized, the place to come back to is the one from before.
  const { x, y, width, height } = fullscreen || win.isMinimized() ? loadState().window ?? {} : win.getNormalBounds();
  saveState({ window: { x, y, width, height, fullscreen } });
}

// The page as the window last loaded it (dev reloads compare against this), and whether that load failed.
let uiShown = null;
let loadFailed = false;
function loadUi() {
  if (!liveWin()) return;
  loadFailed = false;
  if (IS_DEV) { try { uiShown = readFileSync(UI_INDEX, 'utf8'); } catch { uiShown = null; } }
  win.loadFile(UI_INDEX, { query: { vibrancy: process.platform === 'darwin' ? '1' : '0' } })
    .catch((err) => { if (err?.errno !== -3) loadFailed = true; }); // -3: replaced by a newer load
}

// Remember where the window is. Debounced: 'move' and 'resize' fire continuously during a drag.
function watchBounds() {
  let boundsTimer = null;
  const saveBoundsSoon = () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 400); };
  for (const ev of ['resize', 'move', 'enter-full-screen', 'leave-full-screen']) win.on(ev, saveBoundsSoon);
  win.on('closed', () => clearTimeout(boundsTimer));
}

// Closing the window quits Canopy and stops Claude: ask first while a turn is running (this also holds ⌘Q).
function askBeforeClose() {
  let asking = false;
  win.on('close', (e) => {
    if (quitting || !anyWorking()) { closeAsked = Date.now(); saveBounds(); return; }
    e.preventDefault();
    if (asking) return;
    asking = true;
    askWhileWorking('quit').then((choice) => {
      asking = false;
      if (choice === 'now') return quitNow();
      if (choice !== 'wait') return;
      quitPending = true;
      send('app:quit-pending');
      maybeQuit(); // it may have finished while you were deciding
    }).catch((err) => { asking = false; reportError('quit question', err); }); // never left "asking": the next close asks again
  });
}

// The window's console. From source, errors and warnings are written to the log, to be inspected later. Always, an
// error from Canopy's own page is counted by telemetry (which sends its text only when the JavaScript engine worded
// it: src/telemetry/errors.mjs). Never one from a frame inside the page: those are widgets, running code Claude or a
// connector wrote, and what they log is theirs.
function relayConsole(wc) {
  wc.on('console-message', (e) => {
    if (e.level !== 'warning' && e.level !== 'error') return;
    if (IS_DEV) log(`ui ${e.level === 'error' ? 'ERROR' : 'warn'}: ${String(e.message).slice(0, 400)} (${String(e.sourceId).split('/').pop()}:${e.lineNumber})`);
    if (e.level !== 'error') return;
    let ownPage = false;
    try { ownPage = !!e.frame && e.frame.parent === null; } catch { /* the frame is already gone: can't tell, so not counted */ }
    if (ownPage) telemetry.error('ui', { message: String(e.message), source: String(e.sourceId) });
  });
}

// When the page fails: it could not load, its process is gone, or it hangs.
function recoverPage(wc) {
  // The page could not load. From source that means no build yet (the dev poller loads it once one lands);
  // in a packaged app, say so instead of leaving an empty window.
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: a navigation we cancelled, or one a newer load replaced
    loadFailed = true;
    log(`ui failed to load: ${desc} (${code}) ${url}`);
    if (IS_DEV) return;
    dialog.showMessageBox(win, {
      type: 'error', message: 'Canopy could not open its window',
      detail: `${desc} (${code}). If this keeps happening, reinstall Canopy.`,
      buttons: ['Try Again', 'Quit'], defaultId: 0, cancelId: 1,
    }).then(({ response }) => { if (response === 1) quitNow(); else loadUi(); }).catch((err) => reportError('dialog', err));
  });

  // If the UI process crashes, reload it. The session keeps running in main. A page that crashes every
  // time it loads would reload forever, so after three crashes in a minute, stop and ask.
  const crashes = [];
  wc.on('render-process-gone', (_e, d) => {
    log(`ui process gone: ${d.reason} (exit code ${d.exitCode})`);
    dropQuestion();
    if (d.reason === 'clean-exit' || !liveWin()) return;
    closeTerm(); // its terminal view went with it
    const now = Date.now();
    while (crashes.length && now - crashes[0] > 60_000) crashes.shift();
    crashes.push(now);
    const reload = () => { if (liveWin()) wc.reload(); };
    if (crashes.length <= 3) { setTimeout(reload, 500); return; }
    crashes.length = 0;
    dialog.showMessageBox(win, {
      type: 'error', message: 'Canopy keeps crashing',
      detail: 'The window crashed several times in a row. Your chats are saved.',
      buttons: ['Reload', 'Quit'], defaultId: 0, cancelId: 1,
    }).then(({ response }) => { if (response === 1) quitNow(); else reload(); }).catch((err) => reportError('dialog', err));
  });
  // A page that hangs never recovers on its own. Reload means ending its process: the handler above brings it back.
  let hung = null;
  win.on('unresponsive', () => {
    uiHung = true;
    dropQuestion();
    log('ui not responding');
    // Electron also reports this when a window told to close has not closed within 5 s. It is on its
    // way out: close it for real instead of asking, or the quit would never finish.
    if (Date.now() - closeAsked < 15_000) { win.destroy(); return; }
    if (hung) return;
    hung = new AbortController();
    dialog.showMessageBox(win, {
      type: 'warning', message: 'Canopy is not responding',
      detail: 'You can wait for it, or reload the window. Your chats keep working either way.',
      buttons: ['Wait', 'Reload'], defaultId: 0, cancelId: 0, signal: hung.signal,
    }).then(({ response }) => { hung = null; if (response === 1 && liveWin()) wc.forcefullyCrashRenderer(); })
      .catch((err) => { hung = null; reportError('dialog', err); }); // cleared either way, so the question can be asked again
  });
  win.on('responsive', () => { uiHung = false; hung?.abort(); });
}

// The window only ever shows Canopy's own page. Links (and anything else that tries to navigate it)
// go to the browser; nothing gets embedded, and the page gets no web permission beyond copying text.
function lockDown(wc) {
  wc.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e) => { if (e.url !== wc.getURL()) { e.preventDefault(); openExternalSafe(e.url); } });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  // Frames inside the page are widgets (renderer/src/components/canopy/widget-frame.tsx): HTML Claude or a connector
  // wrote, in a sandbox with a policy of its own that allows no loading at all. This is the second wall, held from
  // out here where nothing in the page can reach it: such a frame never goes anywhere, and never touches the network
  // or a file. (Its own page arrives as srcdoc, which is not a request.)
  wc.on('will-frame-navigate', (e) => { if (!e.isMainFrame && !/^about:(srcdoc|blank)$/.test(e.url)) e.preventDefault(); });
  wc.session.webRequest.onBeforeRequest((d, done) => {
    let inner = d.resourceType === 'subFrame';
    try { inner ||= !!d.frame?.parent; } catch { /* the frame is already gone */ }
    done({ cancel: inner && d.webContentsId === wc.id && !/^(data|blob|about|devtools|chrome-extension):/i.test(d.url) });
  });
  wc.session.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
}

// Right-click: spelling fixes, copy and paste, Look Up.
function contextMenu(wc) {
  wc.on('context-menu', (_e, p) => {
    const t = [];
    for (const s of p.dictionarySuggestions.slice(0, 5)) t.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (p.misspelledWord) t.push({ label: 'Learn Spelling', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
    t.push({ type: 'separator' });
    if (p.linkURL) t.push({ label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
    const selection = p.selectionText.trim();
    if (p.isEditable) {
      const f = p.editFlags;
      t.push({ role: 'cut', enabled: f.canCut }, { role: 'copy', enabled: f.canCopy }, { role: 'paste', enabled: f.canPaste },
        { type: 'separator' }, { role: 'selectAll', enabled: f.canSelectAll });
    } else if (selection) {
      t.push({ role: 'copy' }, { label: `Look Up “${selection.length > 24 ? `${selection.slice(0, 24)}…` : selection}”`, click: () => wc.showDefinitionForSelection() });
    }
    if (IS_DEV) t.push({ type: 'separator' }, { label: 'Inspect Element', click: () => wc.inspectElement(p.x, p.y) });
    // buildFromTemplate drops leading, trailing and doubled separators.
    if (t.some((item) => item.type !== 'separator')) Menu.buildFromTemplate(t).popup({ window: win });
  });
}

function createWindow() {
  // macOS: the window is an NSVisualEffectView ('sidebar' material). The page is clear only where the
  // notebook sidebar is translucent; every other surface paints opaque. Never changed at runtime.
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    icon: ICON,
    ...WIN_SIZE, ...savedBounds(), minWidth: WIN_MIN.width, minHeight: WIN_MIN.height, // scaled by applyUiSize
    title: 'Canopy', backgroundColor: mac ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#181715' : '#ffffff'),
    ...(mac ? { vibrancy: 'sidebar', visualEffectState: 'followWindow' } : {}),
    titleBarStyle: 'hiddenInset', trafficLightPosition: lightsAt(uiFactor()),
    // backgroundThrottling off: keep rendering and animations running while Canopy isn't the front app,
    // so replies that finish in the background are fully drawn when you come back.
    // Developer tools, and the page's own dev-only parts (the Playground), exist only when running from source.
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
      devTools: IS_DEV, additionalArguments: IS_DEV ? ['--canopy-dev'] : [] },
  });
  const wc = win.webContents;
  applyUiSize(); // also sets the sheet offset: Finder sheets attach below the toolbar, not over the traffic lights
  if (loadState().window?.fullscreen) win.setFullScreen(true);

  watchBounds();
  askBeforeClose();
  win.on('closed', () => { win = null; });
  relayConsole(wc);
  recoverPage(wc);
  // Reapply the chosen UI size on every load (it also replaces any level Chromium kept for the page).
  wc.on('did-finish-load', () => {
    applyUiSize(); dropQuestion();
    // The window is up: this Canopy started. An update that was just installed is confirmed by that (the version
    // before it is let go), and from here on Canopy looks for the next one.
    if (!startConfirmed) { startConfirmed = true; appUpdate.confirmStarted().then(() => { if (!stopped) appUpdate.start(); }).catch(() => {}); if (SELFTEST) selfTest(); }
  });
  lockDown(wc);
  contextMenu(wc);

  whenUiBuilt().then(loadUi);
}

// Bring the window to the front from anywhere: hidden (⌘H), minimized, or behind other apps.
function showWindow() {
  if (!liveWin()) return;
  if (process.platform === 'darwin') app.show();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  app.focus({ steal: true });
}

// The icon in the macOS menu bar (src/tray.mjs): what's running, and a way back into any chat.
const menuBarUsed = () => telemetry.track('feature_used', { name: 'menu_bar_used' });
function createMenuBar() {
  if (process.platform !== 'darwin' || menuBar) return;
  // From source the version number never moves, so the commit says which build this is.
  let version = app.getVersion();
  if (IS_DEV) execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, timeout: 3000 }, (err, out) => { if (!err && String(out).trim()) version = `${app.getVersion()} (${String(out).trim()})`; });
  try {
    menuBar = new MenuBar({
      electron: { Menu, Tray, nativeImage, systemPreferences }, assets: path.join(ROOT, 'assets', 'tray'), version: () => version,
      // Telemetry counts each pick from the menu bar's menu as one use of it, whichever item it was.
      onOpenChat: (c) => { menuBarUsed(); showWindow(); send('chats:focus', c); },
      onNewChat: () => { menuBarUsed(); showWindow(); send('app:new-chat'); },
      onShow: () => { menuBarUsed(); showWindow(); },
      onQuit: () => { menuBarUsed(); app.quit(); }, // through the window's close, so it still asks while Claude is working
      log,
    });
  } catch (err) { reportError('menu bar', err); }
}

/** An SF Symbol for a menu item, sized and tinted like the system's own menu icons (About, Quit…). */
function menuSymbol(name) {
  try {
    const img = nativeImage.createFromNamedImage(name);
    if (img.isEmpty()) return undefined;
    const { width, height } = img.getSize();
    const out = img.resize({ width: Math.round((width / height) * 15), height: 15, quality: 'best' });
    out.setTemplateImage(true);
    return out;
  } catch { return undefined; }
}

// Canopy's own menu bar. Zoom is Canopy's UI size (see applyUiSize), not Chromium's; no Electron help
// links; Reload and the developer tools only when running from source.
function setAppMenu() {
  const appMenu = { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { label: 'Restart Canopy', accelerator: 'Alt+Command+R', icon: menuSymbol('arrow.clockwise'), click: () => restartFromMenu() }, { role: 'quit' }] };
  const size = uiSize();
  const dev = IS_DEV ? [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }] : [];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [appMenu] : []),
    { role: 'fileMenu' }, // Close Window (⌘W)
    { role: 'editMenu' },
    { label: 'View', submenu: [...dev,
      { label: 'Actual Size', enabled: size !== 100, click: () => stepUiSize(0) }, // no ⌘0: that's Home
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', enabled: size < UI_SIZES.at(-1), click: () => stepUiSize(1) },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', enabled: size < UI_SIZES.at(-1), visible: false, acceleratorWorksWhenHidden: true, click: () => stepUiSize(1) },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', enabled: size > UI_SIZES[0], click: () => stepUiSize(-1) },
      { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}

// ---------- Restart ----------
// Canopy > Restart Canopy, and from source the Update ready card: Canopy comes back where it was, once no chat is
// working (or now, if you say so).

// A restart while chats are working stops them. Each one gets a line in its own transcript, at that moment, every time
// it loads: "Canopy restarted while this chat was working…". Kept in state.json (restartNotes: sessionId -> [{at, helpers}]).
function noteRestartedChats() {
  const hit = [...(chats?.status.values() ?? [])].filter((e) => e.sessionId && (e.state === 'working' || e.state === 'needs-you' || (e.helpers || 0) > 0));
  if (!hit.length) return;
  const notes = { ...(loadState().restartNotes ?? {}) };
  const at = Date.now();
  for (const e of hit) notes[e.sessionId] = [...(notes[e.sessionId] ?? []), { at, helpers: e.helpers || 0 }].slice(-5);
  const keep = Object.keys(notes).slice(-60); // the newest 60 chats
  saveState({ restartNotes: Object.fromEntries(keep.map((k) => [k, notes[k]])) });
}
function withRestartNotes(sessionId, history) {
  const notes = sessionId ? (loadState().restartNotes ?? {})[sessionId] : null;
  if (!notes?.length) return history;
  const out = history.slice();
  for (const n of notes) {
    const what = n.helpers ? ` · stopped ${n.helpers === 1 ? 'an agent' : `${n.helpers} agents and workflows`}` : '';
    const ev = { kind: 'notice', level: 'warn', brand: true, at: n.at, text: `Canopy restarted while this chat was working${what}. Ask it to continue.` };
    let i = out.findIndex((x) => typeof x.at === 'number' && x.at > n.at);
    if (i < 0) i = out.length;
    out.splice(i, 0, ev);
  }
  return out;
}

/** Canopy menu → Restart Canopy. Reopens right where you were. If chats are working, ask: wait for them, or go now. */
async function restartFromMenu() {
  const busy = chats?.workingCount() ?? 0;
  relaunchPending = true;
  if (!busy) return maybeRelaunch();
  let choice;
  // A question that could not be asked is no "wait": the next chat to finish must not restart Canopy on its own.
  try { choice = await askWhileWorking('restart'); } catch (err) { relaunchPending = false; reportError('restart question', err); return; }
  if (choice === 'cancel') { relaunchPending = false; return; }
  if (choice === 'now') return maybeRelaunch(true);
  // Otherwise the turn-end hook relaunches once every chat is done.
}

let relaunchPending = false; // a restart was asked for: it happens as soon as nothing is working
let relaunching = false;
async function maybeRelaunch(force = false) {
  log(`maybeRelaunch pending=${relaunchPending} busy=${anyWorking()} force=${force}`);
  if (!relaunchPending || (!force && anyWorking()) || relaunching) return;
  relaunching = true;
  relaunchPending = false;
  noteRestartedChats();
  // Save exactly where we are (the chat and the window) so the new instance reopens it.
  saveBounds();
  saveState({ lastFolder: currentCwd, lastSession: current?.sessionId ?? null, lastEngine: engineOf(current) });
  shutdown(); // also stops the UI watcher: the new instance starts its own
  log('relaunching');
  await Promise.all([flushWrites(), closeTelemetry()]); // app.exit below skips 'will-quit', so telemetry closes here
  // An update that is downloaded and ready goes in with any restart: the helper waits for this process to exit,
  // swaps the app and opens the new one. Otherwise Canopy opens itself again.
  if (!appUpdate.install({ relaunch: true })) {
    const args = process.argv.slice(1).filter((a) => a !== '--canopy-reopen');
    app.relaunch({ args: [...args, '--canopy-reopen'] });
  }
  try { win?.destroy(); } catch {}
  app.exit(0);
}

// ---------- Dev: UI rebuilds (only when running from source, never in a packaged app) ----------
// The UI always runs as a production build (fast React, nothing compiling in this process).
// In dev, a separate `vite build --watch` process rebuilds it and the window reloads on change.
const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const watcherPidFile = () => path.join(app.getPath('userData'), 'ui-watcher.pid');
let uiWatcher = null;

// A run that died without quitting leaves its watcher behind, and two watchers keep emptying dist-ui
// under each other. Stop the old one, but only if that pid really is this checkout's watcher.
async function stopLeftoverWatcher() {
  let pid;
  try { pid = Number((await readFile(watcherPidFile(), 'utf8')).trim()); } catch { return; }
  if (!Number.isInteger(pid) || pid < 2) return;
  const cmd = await new Promise((resolve) => execFile('/bin/ps', ['-p', String(pid), '-o', 'command='], (err, out) => resolve(err ? '' : String(out))));
  if (!cmd.includes(`${VITE_BIN} build --watch`)) return;
  try { process.kill(pid); log(`stopped a leftover ui watcher (pid ${pid})`); } catch { /* already gone */ }
}

// The watcher's output: everything goes to the log, and a failed build also shows as a toast
// (otherwise it just looks as if edits are not landing).
let lastBuildNote = '';
function onBuildOutput(chunk) {
  const text = String(chunk).replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!text) return;
  const failed = /error during build|Build failed|\[vite\].*error/i.test(text);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // The same warnings come back on every rebuild: write them once.
  if (failed || text !== lastBuildNote) for (const l of lines.slice(0, 40)) log(`ui build: ${l}`);
  lastBuildNote = text;
  if (!failed) return;
  // "Build failed with 1 error:" / "[PARSE_ERROR] Unexpected token" / "╭─[ src/App.tsx:12:3 ]"
  const what = lines[lines.findIndex((l) => /Build failed|error during build/i.test(l)) + 1] ?? lines[0];
  const where = lines.find((l) => /^╭─\[ .+ \]$/.test(l))?.slice(4, -2);
  notify(`UI build failed: ${what}${where ? ` (${where})` : ''}`.slice(0, 300));
}

// Dev: the watcher rebuilds the UI every time Canopy starts, emptying and rewriting dist-ui. A window that loads
// during that rebuild can get half old, half new files: it crashed ("reading 'default'") and reloaded itself, or
// found no index.html at all. So the first load waits until that build has finished writing (index.html changed and
// then held still), with a 20s fallback so a stuck build never leaves the window blank.
let uiBuilt = !IS_DEV || process.env.CANOPY_NO_WATCH === '1';
const uiBuiltWaiters = [];
function markUiBuilt() { if (uiBuilt) return; uiBuilt = true; for (const f of uiBuiltWaiters.splice(0)) f(); }
function whenUiBuilt() {
  if (uiBuilt) return Promise.resolve();
  return new Promise((resolve) => {
    uiBuiltWaiters.push(resolve);
    setTimeout(() => { if (!uiBuilt) { log('first ui build is slow: loading the window anyway'); markUiBuilt(); } }, 20000);
  });
}
const indexStamp = () => { try { return statSync(UI_INDEX).mtimeMs; } catch { return 0; } };
function watchFirstBuild(before) {
  let seen = 0, still = 0;
  const id = setInterval(() => {
    const m = indexStamp();
    if (!m || m === before) return;
    still = m === seen ? still + 1 : 0; // index.html is written last; wait for it to hold still for ~200ms
    seen = m;
    if (still >= 2) { clearInterval(id); markUiBuilt(); }
  }, 100);
}

async function startRenderer() {
  if (!IS_DEV || process.env.CANOPY_NO_WATCH === '1') return markUiBuilt();
  await stopLeftoverWatcher();
  if (stopped) return markUiBuilt(); // quit while we were looking
  watchFirstBuild(indexStamp());
  // Rebuilds never delete: Vite's default empties dist-ui first, so a window loading mid-rebuild (a restart while files
  // are being saved) found its scripts gone and crashed ("reading 'default'", or no index.html at all). Old hashed files
  // are harmless leftovers; they're cleared here, once, before the first build (the window waits for that build).
  try { rmSync(path.join(path.dirname(UI_INDEX), 'assets'), { recursive: true, force: true }); } catch {}
  const child = spawn(process.execPath, [VITE_BIN, 'build', '--watch', '--logLevel', 'warn'], {
    cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true', CANOPY_DEV_WATCH: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  uiWatcher = child;
  child.stdout.on('data', onBuildOutput);
  child.stderr.on('data', onBuildOutput);
  child.on('error', (err) => { log(`ui watcher could not start: ${err.message}`); markUiBuilt(); });
  child.on('exit', (code, signal) => {
    log(`ui watcher exited (${signal ?? `code ${code}`})`);
    if (uiWatcher !== child) return; // we stopped it
    stopUiWatcher();
    notify('The UI build watcher stopped, so UI edits will not show up. Restart Canopy to bring it back.');
  });
  if (child.pid) { try { writeFileSync(watcherPidFile(), String(child.pid)); } catch {} }
}
function stopUiWatcher() {
  const child = uiWatcher;
  if (!child) return;
  uiWatcher = null;
  try { child.kill(); } catch {}
  try { rmSync(watcherPidFile(), { force: true }); } catch {}
}

// Show a new UI build. Reads the file again at reload time, so uiShown is what the window really loads.
function reloadUi() {
  if (!liveWin()) return;
  try { uiShown = readFileSync(UI_INDEX, 'utf8'); } catch { return; } // mid-build: the next poll retries
  win.webContents.reload();
}

// ---------- Dev auto-reload (only when running from source, never in a packaged app) ----------
let engineUpdated = false; // an engine file changed since start: a restart applies it (the Update ready card)
// Poll engine files' timestamps. (fs.watch silently stopped reporting changes here.)
let devPoller = null;
function startDevWatcher() {
  if (!IS_DEV) return;
  // Every file of the main process (src, src/core, src/telemetry), listed again at each poll, so a new module also
  // offers the restart.
  const engineFiles = () => ['.', 'core', 'telemetry'].flatMap((dir) => {
    try { return readdirSync(path.join(__dirname, dir)).filter((f) => /\.(mjs|cjs)$/.test(f)).map((f) => path.join(__dirname, dir, f)); }
    catch { return []; }
  });
  let files = engineFiles();
  const stamp = async () => {
    const out = {};
    for (const f of files) { try { out[f] = (await stat(f)).mtimeMs; } catch { out[f] = 0; } }
    return out;
  };
  let last = null;
  let reloadTimer = null;
  devPoller = setInterval(async () => {
    // A new UI build: compare what index.html says, not when it was written. Asset names carry a content
    // hash, so a rebuild that changed nothing (the watcher's first build on every start) yields the same
    // page and the window keeps its draft, queue and scroll position.
    try {
      if (!uiBuilt) throw 0; // the first load is still waiting for the startup build
      const html = await readFile(UI_INDEX, 'utf8');
      if (loadFailed) loadUi(); // there was no build when the window opened: there is one now
      else if (html !== uiShown && !dialogOpen && !reloadTimer) reloadTimer = setTimeout(() => { reloadTimer = null; reloadUi(); }, 250);
    } catch { /* mid-build */ }
    const now = await stamp();
    files = engineFiles();
    if (last && files.some((f) => last[f] !== undefined && now[f] !== last[f])) {
      // Never restart on its own (that looked like a crash/reset, e.g. right after stopping a chat).
      // Tell the UI; the user restarts when they choose.
      log('engine file changed, restart offered');
      engineUpdated = true;
      send('dev:engine-updated');
    }
    last = now;
  }, 1000);
  log('dev poller started');
}

// ---------- Start and quit ----------
// Telemetry starts in the background: its files, then app_opened once the first environment check has said what this
// Mac has. The window waits for none of it.
function startTelemetry() {
  telemetry.init();
  ensureEnv().then(trackAppOpened).catch(() => {}); // the same check startUpkeep waits for; if it fails, that is reported there
  // The daily summary, once telemetry's saved state is read and the shell has said where Claude Code and Codex keep
  // their history. It checks half a minute from now and then hourly; whether a check may read or send anything is
  // asked each time (its `enabled`), so it follows the switch without being restarted.
  Promise.all([telemetry.init(), ensureEnv()]).then(findCanopySince).then(() => { if (!stopped) daySummary.start(); }).catch(() => {});
  // The `live` heartbeat: every five minutes while Canopy is open, how much is going on right now (counts only, from
  // the chats' own status). It is what "who's using Canopy right now, and how hard" is read from. The first one goes
  // a minute after launch, once chats have had a moment to come back.
  const beat = () => { if (!stopped && chats) telemetry.track('live', chats.liveCounts()); };
  setTimeout(beat, 60_000);
  liveBeat = setInterval(beat, LIVE_EVERY_MS);
}
const LIVE_EVERY_MS = 5 * 60_000;
let liveBeat = null;
// Telemetry's last words, once, on every way out: how long Canopy was open and in use, then one try at sending what
// is queued. It never rejects and never takes more than two seconds, so it can't hold a quit; what isn't sent in
// time is on disk for the next launch.
let telemetryClosed = null;
function closeTelemetry() {
  return (telemetryClosed ??= (async () => {
    clearInterval(liveBeat);
    daySummary.stop(); // a scan under way is ended with its process; the days it had not sent go out next launch
    engineEvents.onQuit(); // what a chat still held (a message waiting to learn its model) goes out before app_closed
    telemetry.track('app_closed', telemetry.sessionMinutes());
    await telemetry.shutdown({ timeoutMs: 2000 });
  })());
}

// One cleanup path for every way out: ⌘Q, the Dock, closing the window, a dev restart.
let stopped = false;
function shutdown() {
  if (stopped) return;
  stopped = true;
  clearInterval(devPoller);
  appUpdate.stop();
  upkeep?.stop();
  accountFolders.stop();
  codexUpkeep?.stop();
  menuBar?.destroy();
  menuBar = null;
  try { if (chats) chats.closeAll(); else current?.close(); } catch {}
  runs.stopAll(); // commands run from the chat end with the app, as a Terminal window's do
  codexService.close().catch(() => {}); // the shared Codex helper, if it is up
  codexKeyService.close().catch(() => {}); // and the one started for a pasted key
  toolRelay.close().catch(() => {});    // and the socket Codex chats call Canopy's tools on
  closeTerm();
  signIn.stop(); // a sign-in still running in the window
  stopUiWatcher();
}

if (!PRIMARY) app.quit(); // Canopy is already running: that copy comes to the front instead
else {
  trimLog();
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    if (stopped) return; // asked to quit before we were ready
    try { app.dock?.setIcon(ICON); } catch {}
    if (process.argv.includes('--canopy-reopen')) process.env.CANOPY_REOPEN = '1';
    app.setAboutPanelOptions({ applicationName: 'Canopy', applicationVersion: app.getVersion() });
    setAppMenu();
    // Read today's transcripts once in the background, so Home's first open finds them read (later reads are only new lines).
    setTimeout(() => today().catch(() => {}), 5000);
    // The window comes first: its loading view covers the environment check (login shell, claude
    // version, sign-in state), which runs meanwhile. app:init waits for it.
    ensureEnv().then(() => { startUpkeep(); startCodexUpkeep(); }).catch((err) => reportError('environment check', err));
    startTelemetry();
    canopyAccount.resume().catch(() => {}); // renews your Canopy session if it's close to running out
    createWindow();
    createMenuBar();
    startRenderer().catch((err) => reportError('ui watcher', err));
    startDevWatcher();
  });

  app.on('window-all-closed', () => { if (!relaunching) app.quit(); });
  // 'will-quit' runs however Canopy quits; 'window-all-closed' alone is skipped on ⌘Q.
  let flushed = false;
  app.on('will-quit', (e) => {
    shutdown();
    // Quitting with an update downloaded: it is installed once this process has gone, and the next launch is the new Canopy.
    if (!relaunching && appUpdate.installsOnQuit) appUpdate.install({ relaunch: false });
    if (flushed) return;
    // Hold the quit until queued writes land, then quit for real. On a later tick: with nothing to wait
    // for we would still be inside this event, where Electron ignores a second quit.
    // Telemetry closes alongside (two seconds at most, usually none); the log lines it wrote land after it.
    e.preventDefault();
    flushed = true;
    Promise.all([flushWrites(), closeTelemetry()]).then(flushWrites).finally(() => setTimeout(() => app.quit(), 0));
  });
}

// The only bridge between the UI and the Node side. The UI gets this API and nothing else.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('canopy', {
  // True only when Canopy runs from source: the page's dev-only parts (the Playground, ?mock=) exist only then.
  dev: process.argv.includes('--canopy-dev'),
  init: () => ipcRenderer.invoke('app:init'),
  recheck: () => ipcRenderer.invoke('app:recheck'),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  listSessions: (cwd) => ipcRenderer.invoke('sessions:list', cwd),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  removeProject: (dir) => ipcRenderer.invoke('projects:remove', dir),
  reorderProjects: (dirs) => ipcRenderer.invoke('projects:reorder', dirs),
  rename: (id, title, cwd) => ipcRenderer.invoke('session:rename', id, title, cwd),
  mcpStatus: () => ipcRenderer.invoke('session:mcp'),
  gitInfo: (cwd) => ipcRenderer.invoke('git:info', cwd),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  openPath: (p, cwd, reveal) => ipcRenderer.invoke('path:open', p, cwd, reveal),
  readImage: (p, cwd) => ipcRenderer.invoke('image:read', p, cwd),
  fileThumb: (p, cwd) => ipcRenderer.invoke('file:thumb', p, cwd),
  // Settings → Customize (src/customize.mjs)
  customize: {
    mcpList: (cwd) => ipcRenderer.invoke('customize:mcp:list', cwd),
    mcpAdd: (spec, cwd) => ipcRenderer.invoke('customize:mcp:add', spec, cwd),
    mcpRemove: (name, scope, cwd) => ipcRenderer.invoke('customize:mcp:remove', name, scope, cwd),
    mcpGet: (name, cwd) => ipcRenderer.invoke('customize:mcp:get', name, cwd),
    pluginsList: (opts) => ipcRenderer.invoke('customize:plugins:list', opts),
    pluginAction: (action, id, scope) => ipcRenderer.invoke('customize:plugins:action', action, id, scope),
    pluginDetails: (id) => ipcRenderer.invoke('customize:plugins:details', id),
    marketplaces: () => ipcRenderer.invoke('customize:marketplaces:list'),
    marketplaceAdd: (source) => ipcRenderer.invoke('customize:marketplaces:add', source),
    skillsList: (cwd) => ipcRenderer.invoke('customize:skills:list', cwd),
    skillRead: (file) => ipcRenderer.invoke('customize:skills:read', file),
  },
  listFiles: (cwd) => ipcRenderer.invoke('files:list', cwd),
  pickFiles: (cwd) => ipcRenderer.invoke('files:pick', cwd),
  attach: () => ipcRenderer.invoke('session:attach'),
  snapshot: () => ipcRenderer.invoke('session:snapshot'),
  // "Show earlier": the turns just older than the ones a very long chat opened with ({ events } or { error }).
  earlier: (sessionId, cwd, cursor) => ipcRenderer.invoke('session:earlier', sessionId, cwd, cursor),
  // opts: { engine?: 'claude' | 'codex', replaceEmpty?: boolean, move?: { from, fromModel, toModel } }. `move`: the new
  // chat carries on from the chat `from`. The reply says which engine the chat runs on.
  open: (cwd, resume, opts) => ipcRenderer.invoke('session:open', cwd, resume, opts),
  send: (text, images, id) => ipcRenderer.invoke('session:send', text, images, id),
  // Edit and resend: the message and everything after it go, Claude answers the new text.
  edit: (opts) => ipcRenderer.invoke('session:edit', opts),
  editPreview: (messageId) => ipcRenderer.invoke('session:edit-preview', messageId),
  queue: (text, images) => ipcRenderer.invoke('session:queue', text, images),
  unqueue: (id) => ipcRenderer.invoke('session:unqueue', id),
  requeue: (id, to) => ipcRenderer.invoke('session:requeue', id, to),
  interrupt: () => ipcRenderer.invoke('session:interrupt'),
  set: (key, value) => ipcRenderer.invoke('session:set', key, value),
  respond: (id, answer) => ipcRenderer.invoke('session:respond', id, answer),
  context: () => ipcRenderer.invoke('session:context'),
  widgetReport: (toolUseId, report) => ipcRenderer.invoke('widget:report', toolUseId, report),
  widgetShot: (sessionId, ref) => ipcRenderer.invoke('widget:shot', sessionId, ref),
  onEvent: on('session:event'),
  stopTask: (taskId) => ipcRenderer.invoke('session:task-stop', taskId),
  workflowAgents: (cwd, sessionId) => ipcRenderer.invoke('workflow:agents', cwd, sessionId),
  agentSteps: (cwd, sessionId, agentId) => ipcRenderer.invoke('agent:steps', cwd, sessionId, agentId),
  chatTotals: (cwd, sessionId) => ipcRenderer.invoke('session:totals', cwd, sessionId),
  onChatsStatus: on('chats:status'),
  onSessionsChanged: on('sessions:changed'), // the list of saved chats changed on the Node side (a name, a new or replaced chat): read it again
  // The model picker's rows by maker: { claude, openai, codex }. `openai` is empty when Codex isn't there to offer any.
  models: () => ipcRenderer.invoke('models:list'),
  onModelsChanged: on('models:changed'),
  // Signing in to Codex (src/accounts-codex-ipc.mjs): the sheet's state, and what a user can ask for. The sign-in is
  // Codex's own, in the browser; its address never comes to the window. `signOut` goes ahead only with `true`.
  codexLogin: {
    state: () => ipcRenderer.invoke('accounts:codex'),
    start: () => ipcRenderer.invoke('accounts:codex-signin'),
    cancel: () => ipcRenderer.invoke('accounts:codex-cancel'),
    reopen: () => ipcRenderer.invoke('accounts:codex-reopen'),
    dismiss: () => ipcRenderer.invoke('accounts:codex-dismiss'),
    signOut: (confirmed) => ipcRenderer.invoke('accounts:codex-signout', confirmed),
    onChanged: on('accounts:codex'),
  },
  // Codex chats another app has open right now (src/codex-held.mjs): { [chat id]: { app, line, text } }.
  heldChats: () => ipcRenderer.invoke('codex:held'),
  onHeldChats: on('codex:held'),
  chatsList: () => ipcRenderer.invoke('chats:list'),                   // parallel chats: every open chat's state (src/chats.mjs)
  searchChats: (query) => ipcRenderer.invoke('chats:search', query),   // ⌘K: what was said inside every chat (src/chat-search.mjs)
  onChatsFocus: on('chats:focus'),     // a notification or the menu bar icon picked a chat: open it
  onChatDone: on('chats:done'),        // a chat finished a turn normally: play the completion sound
  onNewChat: on('app:new-chat'),       // "New Chat" in the menu bar icon's menu
  onAppError: on('app:error'),
  onEngineUpdated: on('dev:engine-updated'),
  restartApp: () => ipcRenderer.send('dev:restart'),
  restartState: () => ipcRenderer.invoke('dev:restart-state'),
  restartCancel: () => ipcRenderer.send('dev:restart-cancel'),
  // Quit or Restart with chats working: the window asks in its own dialog and answers 'wait' | 'now' | 'cancel'.
  onRestartAsk: on('app:restart-ask'),
  onQuitPending: on('app:quit-pending'),               // "Quit when done" was picked
  quitCancel: () => ipcRenderer.send('app:quit-cancel'),
  // Home: live status of every chat, and answering or stopping any of them.
  homeList: () => ipcRenderer.invoke('home:list'),
  homeDay: () => ipcRenderer.invoke('home:day'),
  onHomeStatus: on('home:status'),
  homeRespond: (sid, id, answer) => ipcRenderer.invoke('home:respond', sid, id, answer),
  homeStop: (sid) => ipcRenderer.invoke('home:stop', sid),
  homeStopTasks: (sid, ids) => ipcRenderer.invoke('home:stop-tasks', sid, ids),
  restartChoice: (choice) => ipcRenderer.send('app:restart-choice', choice),
  setBadge: (n) => ipcRenderer.send('app:badge', n),
  setTheme: (p) => ipcRenderer.invoke('app:theme', p),
  // A Claude sign-in kept in a folder of its own (src/account-folders.mjs): add one (main shows Claude Code's own
  // sign-in and answers when it ends), or remove one that was added here.
  accountFolders: {
    add: (kind) => ipcRenderer.invoke('account-folders:add', kind),
    remove: (id) => ipcRenderer.invoke('account-folders:remove', id),
  },
  // A second Codex login in a folder of its own (src/codex-account-folders.mjs): Codex's own browser sign-in into a new
  // folder (`add` answers when it ends; the row follows `onChanged`), and removing one added here.
  codexFolders: {
    add: () => ipcRenderer.invoke('codex-folders:add'),
    cancel: () => ipcRenderer.invoke('codex-folders:cancel'),
    reopen: () => ipcRenderer.invoke('codex-folders:reopen'),
    remove: (id) => ipcRenderer.invoke('codex-folders:remove', id),
    onChanged: on('codex-folders:changed'),
  },
  // Claude Code upkeep (src/core/upkeep.mjs): updates, models at their newest, frames Canopy doesn't know yet.
  upkeep: {
    status: () => ipcRenderer.invoke('upkeep:status'),
    check: (which) => ipcRenderer.invoke('upkeep:check', which),          // which: 'codex' for Codex, left out for Claude Code
    setAuto: (on, which) => ipcRenderer.invoke('upkeep:auto', on, which),
    clearDrift: (which) => ipcRenderer.invoke('upkeep:clear-drift', which),
    onStatus: on('upkeep:status'),
  },
  // Canopy's own updates (src/core/app-update.mjs): what is available, downloaded or required, and what Settings changes.
  appUpdate: {
    status: () => ipcRenderer.invoke('app-update:status'),
    check: () => ipcRenderer.invoke('app-update:check'),           // Check for Updates
    download: () => ipcRenderer.invoke('app-update:download'),     // with automatic updates off: download the one on offer
    setAuto: (on) => ipcRenderer.invoke('app-update:auto', on),
    installRequired: () => ipcRenderer.invoke('app-update:required'),      // "Update required": download, install, restart
    cancelRequired: () => ipcRenderer.invoke('app-update:required-cancel'),
    onStatus: on('app-update:status'),
  },
  // Usage stats (src/telemetry): the window's own events, and what Settings needs to show and change. What may be
  // sent is checked in the main process; nothing typed, read or named ever is.
  telemetry: {
    track: (event, props) => ipcRenderer.invoke('telemetry:track', event, props),
    status: () => ipcRenderer.invoke('telemetry:status'),
    set: (patch) => ipcRenderer.invoke('telemetry:set', patch),   // { enabled?: boolean, name?: string }
    recent: () => ipcRenderer.invoke('telemetry:recent'),         // the last 200 events: [{ event, ts, props }]
    noticeShown: () => ipcRenderer.invoke('telemetry:notice-shown'),
    noticeUp: () => ipcRenderer.invoke('telemetry:notice-up'),     // the first-launch notice is on screen now
    onStatus: on('telemetry:status'),
  },
  // What Codex needs before it can use the Mac (src/computer-use.mjs): Settings → Codex, and a failed step's fix.
  computerUse: {
    status: () => ipcRenderer.invoke('computer-use:status'),
    openPane: (key) => ipcRenderer.invoke('computer-use:pane', key),       // key: 'accessibility' | 'screen' | 'automation'
    turnOn: () => ipcRenderer.invoke('computer-use:turn-on'),
    openCodexApp: () => ipcRenderer.invoke('computer-use:codex-app'),
  },
  // Accounts (src/accounts-ipc.mjs): the logins Canopy found for each maker, and which one new chats use.
  /** Your Canopy account (Google sign-in): never a token, only who you are. */
  canopyAccount: {
    get: () => ipcRenderer.invoke('canopyAccount:get'),
    signIn: () => ipcRenderer.invoke('canopyAccount:signIn'),
    cancel: () => ipcRenderer.invoke('canopyAccount:cancel'),
    signOut: () => ipcRenderer.invoke('canopyAccount:signOut'),
    deleteAccount: () => ipcRenderer.invoke('canopyAccount:delete'),
    onChanged: on('canopyAccount:changed'),
  },
  setup: { install: (engine) => ipcRenderer.invoke('setup:install', engine), apps: () => ipcRenderer.invoke('setup:apps') },
  onboarding: {
    get: () => ipcRenderer.invoke('onboarding:get'),
    done: () => ipcRenderer.invoke('onboarding:done'),
  },
  kit: {
    get: () => ipcRenderer.invoke('kit:get'),
    set: (on) => ipcRenderer.invoke('kit:set', on),
  },
  // Canopy Memory: the switch, the notes (Settings lists them), and what a save's row in a chat does to undo it.
  memory: {
    get: () => ipcRenderer.invoke('memory:get'),
    set: (on) => ipcRenderer.invoke('memory:set', on),
    bridge: (on) => ipcRenderer.invoke('memory:bridge', on),
    list: () => ipcRenderer.invoke('memory:list'),
    state: (id) => ipcRenderer.invoke('memory:state', id),
    edit: (id, patch) => ipcRenderer.invoke('memory:edit', id, patch),
    remove: (id) => ipcRenderer.invoke('memory:remove', id),
    restore: (id) => ipcRenderer.invoke('memory:restore', id),
    revert: (id) => ipcRenderer.invoke('memory:revert', id),
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    refresh: (force) => ipcRenderer.invoke('accounts:refresh', force),
    onChanged: on('accounts:changed'),
    // Choosing one, and the API keys pasted into Canopy (src/account-actions.mjs). A key goes in with addKey or
    // replaceKey and never comes back: every reply is { ok } or { ok: false, code, message }.
    use: (engine, id) => ipcRenderer.invoke('accounts:use', engine, id),
    addKey: (engine, key) => ipcRenderer.invoke('accounts:add-key', engine, key),
    replaceKey: (engine, id, key) => ipcRenderer.invoke('accounts:replace-key', engine, id, key),
    rename: (engine, id, label) => ipcRenderer.invoke('accounts:rename', engine, id, label),
    remove: (engine, id) => ipcRenderer.invoke('accounts:remove', engine, id),
  },
  // The Usage tab (src/usage-ipc.mjs): the account in use's limits or spend. `get` is asked while the tab is on screen
  // ({ open: true } when it has just come on screen), `watch(false)` says it went away.
  usage: {
    get: (opts) => ipcRenderer.invoke('usage:get', opts),
    refresh: (engine) => ipcRenderer.invoke('usage:refresh', engine),
    watch: (on) => ipcRenderer.invoke('usage:watch', on),
    onChanged: on('usage:changed'),
  },
  // Signing in again (src/signin-ipc.mjs): Claude Code's own sign-in, in a terminal in the window. `input` and
  // `onData` carry what is typed and printed between that terminal and Claude Code, and nothing else reads them.
  signin: {
    startCheck: () => ipcRenderer.invoke('signin:start-check'),
    begin: (opts) => ipcRenderer.invoke('signin:begin', opts),
    attach: (id, cols, rows, how) => ipcRenderer.invoke('signin:attach', id, cols, rows, how),
    input: (id, data) => ipcRenderer.send('signin:input', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('signin:resize', id, cols, rows),
    terminal: (id) => ipcRenderer.invoke('signin:terminal', id),
    check: (id) => ipcRenderer.invoke('signin:check', id),
    cancel: (id) => ipcRenderer.invoke('signin:cancel', id),
    onData: on('signin:data'),
    onState: on('signin:state'),
  },
  // Multi mode: chats in panes, each addressed by its own id (sid).
  pane: {
    keepAlive: true,
    open: (cwd, resume, opts) => ipcRenderer.invoke('pane:open', cwd, resume, opts), // opts: { engine?, replace?: sid, move? }
    shown: (sids, cached) => ipcRenderer.invoke('pane:shown', sids, cached),
    send: (sid, text, images, id) => ipcRenderer.invoke('pane:send', sid, text, images, id),
    edit: (sid, opts) => ipcRenderer.invoke('pane:edit', sid, opts),
    editPreview: (sid, messageId) => ipcRenderer.invoke('pane:edit-preview', sid, messageId),
    earlier: (sid, sessionId, cwd, cursor) => ipcRenderer.invoke('pane:earlier', sid, sessionId, cwd, cursor),
    queue: (sid, text, images) => ipcRenderer.invoke('pane:queue', sid, text, images),
    unqueue: (sid, id) => ipcRenderer.invoke('pane:unqueue', sid, id),
    requeue: (sid, id, to) => ipcRenderer.invoke('pane:requeue', sid, id, to),
    interrupt: (sid) => ipcRenderer.invoke('pane:interrupt', sid),
    set: (sid, key, value) => ipcRenderer.invoke('pane:set', sid, key, value),
    respond: (sid, id, answer) => ipcRenderer.invoke('pane:respond', sid, id, answer),
    context: (sid) => ipcRenderer.invoke('pane:context', sid),
    stopTask: (sid, taskId) => ipcRenderer.invoke('pane:task-stop', sid, taskId),
    onClosed: on('pane:closed'),
  },
  term: {
    open: (cols, rows) => ipcRenderer.invoke('term:open', cols, rows),
    input: (data) => ipcRenderer.send('term:input', data),
    resize: (cols, rows) => ipcRenderer.send('term:resize', cols, rows),
    close: () => ipcRenderer.invoke('term:close'),
    onData: on('term:data'),
    onExit: on('term:exit'),
  },
  // Run in the chat (src/run-ipc.mjs).
  run: {
    start: (id, opts) => ipcRenderer.invoke('run:start', id, opts),
    input: (id, data) => ipcRenderer.send('run:input', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('run:resize', id, cols, rows),
    stop: (id) => ipcRenderer.invoke('run:stop', id),
    onData: on('run:data'),
    onExit: on('run:exit'),
  },
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
});

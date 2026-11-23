// Typed access to the bridge exposed by src/preload.cjs. The UI talks to
// nothing else.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CanopyEvent = { kind: string; [key: string]: any };

/** Which engine runs a chat: Claude Code, or Codex for OpenAI's models. Fixed for the chat's life, never named in the UI. */
export type Engine = 'claude' | 'codex';
/** `named` false: `title` is still the first message, not a name yet (missing from an older main, and on Codex rows: treat as named).
 *  `engine` is only on chats that run on Codex; Claude's rows have none. */
export type SessionSummary = { id: string; title: string; updated: number; branch: string | null; cwd: string | null; preview?: string | null; named?: boolean; engine?: 'codex';
  /** A chat from the Codex app that belongs to no project. It is listed under Chats (`cwd` is Canopy's own no-project folder); main runs it in its own folder. */
  loose?: boolean };
/** What an open can ask for. `engine` only counts for a new chat (a saved one keeps the engine it started on).
 *  `replaceEmpty` (the main screen) and `replace` (a pane: the sid it held) let go of that chat if it was never used.
 *  `move` (a new chat only): the chat carries on from the chat `from`, which ran on the other maker. The two model
 *  names are the ones on screen at that moment; they are kept for the "Canopy switched from … → …" line.
 *  `back` (a saved chat only): the chat being opened is gone back to from `from`, in the same thread, and is told
 *  what happened while it was away. */
export type OpenOpts = { engine?: Engine; replaceEmpty?: boolean; replace?: string; move?: { from: string; fromModel: string; toModel: string }; back?: { from: string; fromModel: string; toModel: string } };
/** A model picker row, as Claude Code lists them. `supportsFastMode` is true on the models that have Fast and unset on the rest. */
export type ClaudeModel = { value: string; displayName?: string; description?: string; resolvedModel?: string; supportsFastMode?: boolean };
/** A model picker row for an OpenAI model, read live from Codex. The id goes over the wire as it is. */
export type CodexModel = {
  value: string; displayName: string; description: string; engine: 'codex'; maker: 'openai';
  supportsEffort: boolean; supportedEffortLevels: string[]; defaultEffort: string | null; supportsFastMode: boolean; isDefault: boolean;
};
/** What main knows about Codex itself: is it on this Mac, is it signed in (null: it has not said), and how
 *  (`method`: `apiKey`, `chatgpt`; null when signed out or not known). Settings > Models shows it as OpenAI's status line. */
export type CodexInfo = {
  installed: boolean; signedIn: boolean | null; version: string | null; method?: string | null;
  /** The model list file the user's Codex settings point to (model_catalog_json): Codex lists only its models. */
  fixedList?: string | null;
};
/** The picker's rows by maker. `openai` is empty when Codex is missing, signed out or not answering. */
export type ModelGroups = { claude: ClaudeModel[]; openai: CodexModel[]; codex?: CodexInfo };
/** How an account is paid for and where it comes from: a plan, a Console sign-in, an API key, or whatever the environment supplies. */
export type AccountKind = 'plan' | 'console' | 'key' | 'external';
export type AccountState = 'ok' | 'checking' | 'unknown' | 'signed-out' | 'expired' | 'mismatch' | 'missing' | 'locked' | 'invalid-key' | 'blocked';
/** One login (src/core/accounts.mjs). `found`: Canopy found it by asking the tool, and did not add it. `via`: for an
 *  `external` account, what supplies the login (ANTHROPIC_API_KEY, apiKeyHelper, a cloud provider). No secret is ever here. */
export type Account = {
  id: string; engine: Engine; kind: AccountKind; label: string; email: string | null; org: string | null; plan: string | null;
  via: string | null; keyHint: string | null; state: AccountState; why: string | null; found: boolean;
};
/** What a change to the accounts answers: done (with the account's id, when one was added), or why not, in words
 *  a person can read. `error`: main could not handle the call at all. */
export type AccountReply = { ok?: boolean; id?: string; code?: string; message?: string; error?: string };
/** `active`: the account you chose per engine (null: as the tool finds it). `own`: the login the tool finds on its
 *  own, whatever is chosen (what a chat started with nothing chosen runs on). `inUse`: the one new chats really start
 *  on: `active`, else `own`. */
export type AccountsState = { active: Record<Engine, string | null>; inUse: Record<Engine, string | null>; own: Record<Engine, string | null>; checking: boolean; list: Account[] };
/** One window of a plan's limits: how full it is (0 to 100) and when it starts over (ms; null when not known). */
export type UsageWindow = { key: string; label: string; percent: number; resetsAt: number | null };
/** Canopy's own count for an account billed per use, in dollars for either maker. `since`: when counting began (ms),
 *  while that is later than the first of this month. `chat`: the chat on screen, when it runs on this account.
 *  `unpriced`: tokens no price is known for (Codex, on a model that is not in Canopy's price list), which are shown
 *  as tokens beside the dollars; `models` names them, when they are known. Absent when every token has a price. */
export type UsageCount = {
  unit: 'usd'; today: number; month: number; since: number | null; chat: number | null;
  unpriced?: { today: number; month: number; chat: number; models: string[] } | null;
};
/** What the Usage tab shows for one maker's account in use (src/core/usage.mjs). `shape`: a plan's limits, dollars
 *  spent, or `attention` (the account needs you first, so nothing is read for it). `at`: when the
 *  numbers were read, null when there are none yet. `error`: the last read did not work; what there was is kept. */
export type UsageSection = {
  engine: Engine; account: Account; shape: 'plan' | 'spend' | 'attention';
  at: number | null; loading: boolean; error: 'unavailable' | 'unsupported' | 'no-limits' | null;
  plan?: string | null; windows?: UsageWindow[];
  /** Extra usage on a Claude plan. Amounts are in `currency`'s own unit (dollars, not cents), null when not known. */
  extra?: { enabled: boolean; percent: number | null; used: number | null; limit: number | null; currency: string } | null;
  credits?: { unlimited: boolean; balance: string | null } | null;
  /** The window at 90% or more. What may be offered instead is account-rules.ts `limitOffer` (never another plan). */
  near?: { key: string; label: string; percent: number } | null;
  count?: UsageCount | null;
};
/** One section per maker that has an account in use, Claude first. `checking`: the tools are still being asked who is signed in. */
export type UsageView = { sections: UsageSection[]; checking: boolean };
/** A sign-in that is open (src/core/signin.mjs): Claude Code's own, in a terminal in the window.
 *  `ready`: waiting for that terminal. `terminal`: handed to the Terminal app. `checking`: Claude Code is being asked
 *  who signed in. `account`: the one being signed in to again (null: a login that is not listed yet).
 *  `canSwitch`: it may still choose between a Claude plan and the Console. `code`: why it did not count
 *  (`unverified`: Claude Code could not be asked, so asking again is enough). Never any terminal text. */
export type SignInState = {
  id: string; engine: Engine; phase: 'ready' | 'running' | 'checking' | 'done' | 'failed' | 'terminal' | 'closed';
  account: string | null; label: string | null; console: boolean; canSwitch: boolean; code: string | null; message: string | null;
  who: { label: string; email: string | null } | null;
};
/** Signing in to Codex, as main says it stands (src/core/accounts-codex-login.mjs). `phase` is the sheet: idle is no
 *  sheet; starting, waiting and checking are a sign-in under way; done and failed say how it ended (`message`, and
 *  Codex's own words in `detail`). `signedIn` null: Codex has not said. `canSignIn`: Codex is here and has no login
 *  that works, so a sign-in may be offered. Who is signed in is not here: the list of accounts has that. */
export type CodexLogin = {
  phase: 'idle' | 'starting' | 'waiting' | 'checking' | 'done' | 'failed'; message: string | null; detail: string | null;
  installed: boolean; signedIn: boolean | null; canSignIn: boolean; signingOut: boolean;
};
/** What main says about the sign-in, in a line of its own or as the answer to a call: how things stand, whether the
 *  call did what it was for, and `rev`, main's count of changes (an answer with a lower count than one already seen
 *  was overtaken on the way). */
export type CodexLoginReply = Partial<CodexLogin> & { rev?: number; ok?: boolean; code?: string; error?: string };
export type EnvInfo = {
  claudePath: string | null;
  version: string | null;
  /** `loggedIn` null: Claude Code did not answer in time. That is "not known yet", never "signed out". */
  auth?: { loggedIn: boolean | null; method: string | null; org: string | null };
  accounts?: AccountsState;
  /** Has any login ever worked on this Mac? Signed out is only a full-screen stop when none has. */
  everSignedIn?: boolean;
  lastFolder?: string | null;
  userName?: string;
  chatsDir?: string;
  error?: string;
  /** Codex, when it is installed: where, and the version it reported (null until it has answered). */
  codexPath?: string | null;
  codexVersion?: string | null;
  /** Settings: Canopy's version and log file, and the folders Claude Code and Codex keep their setup in. */
  appVersion?: string;
  logFile?: string;
  /** True when Canopy runs from source. */
  dev?: boolean;
  claudeDir?: string;
  codexDir?: string;
};
/** Today in quarter hours, for Home's strip (src/day-activity.mjs). busy is ms Claude was working (two chats at once count once). */
export type HomeDay = { since: number; slot: number; busy: number; cost: number; chats: number; slots: { busy: number; cost: number; chats: number }[] };
export type ImageAttachment = { mediaType: string; data: string; name?: string };
/** What main holds for a chat's message queue (src/chats.mjs), as of `v`. */
export type QueueState = { queue: { id: number; text: string; images: ImageAttachment[] }[]; v: number };
export type QueueReply = Partial<QueueState> & { ok?: boolean; removed?: boolean; moved?: boolean; error?: string };
export type LiveSession = {
  /** The chat's id in main, and the engine's event count when this snapshot was taken (events up to it are in the snapshot). */
  sid?: string; seq?: number;
  cwd: string; sessionId: string | null; busy: boolean; engine?: Engine;
  /** The account the chat is on: an account's id, or null for the login its tool finds on its own. */
  accountId?: string | null;
  settings: { model?: string; permissionMode?: string; effort?: string; fast?: boolean; codeMode?: boolean };
  pending: CanopyEvent[]; history: CanopyEvent[]; meta?: CanopyEvent | null;
  /** The messages waiting behind the chat's turn, and the version of that queue. */
  queue?: QueueState['queue']; queueV?: number;
};
/** Edit and resend. `id` is the new message's uuid; leaving `images` out sends the message's own again. */
export type EditRequest = { messageId: string; text: string; id: string; restoreFiles?: boolean; images?: ImageAttachment[] };
export type EditReply = { ok?: boolean; id?: string; fresh?: boolean; first?: boolean; code?: string; message?: string; error?: string };
/** A page of a very long chat's earlier turns, as events. While there are older ones still, it starts with
 *  `{ kind: 'earlier', cursor }`: where the next page begins. A chat that is read whole answers no events. */
export type EarlierReply = { events?: CanopyEvent[]; error?: string } | null;
/** The files Claude changed since a message (what "also undo" would put back). */
export type EditPreview = { files: string[]; insertions: number; deletions: number } | null;
export type Answer =
  | { action: 'allow' | 'always' | 'deny'; message?: string }
  | { action: 'answers'; answers: Record<string, string> }
  /** What a connected tool asked (a form, a sign-in link, a yes/no): yes with the form's values, no, or walked away. */
  | { action: 'elicit-accept'; content?: Record<string, unknown> }
  | { action: 'elicit-decline' | 'elicit-cancel' }
  | { action: 'plan-approve'; mode: string }
  | { action: 'plan-reject'; message?: string };

export type ComputerUsePane = 'accessibility' | 'screen' | 'automation';
/** Computer Use as Codex has it set up. `on`: null when Codex did not say. `apps`: which apps Codex's config lets it use. */
export type ComputerUseStatus = {
  installed: boolean; version: string | null; on: boolean | null; state: 'on' | 'off' | 'missing' | 'unknown'; line: string;
  apps: { any: boolean; listed: { id: string; access: 'allow' | 'deny' }[] } | null;
  permissions: { key: ComputerUsePane; label: string; detail: string; needed: boolean }[];
};

type Unsub = () => void;

/** A picker row Claude Code pins to an older release, and the row Canopy offers instead (src/core/upkeep.mjs). */
export type ModelFixup = { from: string; was: string; is: string; to: { value: string; displayName?: string; description?: string; resolvedModel?: string } };
export type UpkeepStatus = {
  autoUpdate: boolean;
  /** Why automatic updates can't run (an environment variable), or null. */
  blockedBy: string | null;
  version: string | null;
  /** The Claude Code version Canopy's engine was built against; `behind` when the installed one is older. */
  engineVersion: string | null;
  behind: boolean;
  doing: 'updating' | 'checking-models' | null;
  lastCheck: { at: number; result: 'updated' | 'current' | 'failed'; version: string | null; detail: string | null; reason: string } | null;
  lastUpdate: { at: number; from: string; to: string } | null;
  fixups: ModelFixup[];
  drift: { label: string; keys: string[]; version: string | null; at: number; count: number }[];
  /** Pushed with a status when something just happened worth telling you about. */
  note?: { kind: 'updated' | 'repaired'; from: string; to: string } | { kind: 'drift'; label: string } | null;
  /** The same status for the user's Codex, with its own `note` (`engineVersion` there is the oldest Codex Canopy
   *  works with). Null without Codex on this Mac. */
  codex?: Omit<UpkeepStatus, 'codex'> | null;
};

/** Canopy's own updates, as main keeps them (src/core/app-update.mjs).
 *  `supported` false: this copy never updates itself (`off` says why: run from source, an automated run).
 *  `available`: a newer version exists. `ready`: it is downloaded and a restart installs it.
 *  `required`: this version may no longer be used; the window shows "Update required" with these words.
 *  `canInstall` false: this copy cannot replace itself where it is (opened from the disk image, or a folder it may
 *  not change); `downloadUrl` is where a person gets the new one instead.
 *  `failed`: a version that was installed, did not start, and was taken back out.
 *  `note`: pushed with a status when an update was just installed, or was undone because it did not start. */
export type AppUpdateStatus = {
  supported: boolean; off: 'source' | 'automated' | 'platform' | null; current: string; auto: boolean;
  state: 'idle' | 'checking' | 'downloading' | 'installing'; progress: number | null;
  available: string | null; ready: string | null;
  required: { version: string; message: string } | null;
  error: string | null; failed: string | null; canInstall: boolean;
  lastCheck: { at: number; result: 'current' | 'available' | 'failed' } | null;
  downloadUrl: string | null;
  note?: { kind: 'updated' | 'rolled-back'; version: string } | null;
};

/** Where usage stats stand, as main keeps them (src/telemetry). `endpoint`: there is somewhere to send them.
 *  `lastSentAt` is a time in ms, null before the first send. `noticeShown`: the first-launch notice has been seen.
 *  `blocked`: something outside Settings keeps this copy of Canopy from sending anything, whatever the switch says
 *  ('automated': a test run in a throwaway data folder; 'env': CANOPY_TELEMETRY=0). `sending`: events really leave
 *  this Mac right now (on, not blocked, and there is a server to send them to). */
export type TelemetryStatus = {
  enabled: boolean; name: string; installId: string; endpoint: boolean; queued: number; lastSentAt: number | null; noticeShown: boolean;
  blocked: string | null; sending: boolean;
};
/** One event as it was recorded to be sent: its name, when (ms), and exactly the props that go with it. */
export type TelemetryEvent = { event: string; ts: number | null; props: Record<string, string | number | boolean> };

/** One note of Canopy Memory (src/core/memory-store.mjs). `project` is its folder, for a note about one project;
 *  `replaced` is what the note said before a later save took its place. */
export type MemoryNote = {
  id: string; title: string; text: string; scope: 'me' | 'project'; project: string | null;
  source: 'user-said' | 'model-noticed'; engine: Engine | null; created: number; updated: number; replaced?: string | null;
};

export interface CanopyApi {
  /** True only when Canopy runs from source: the Playground and ?mock= exist only then. */
  dev?: boolean;
  init(): Promise<EnvInfo>;
  recheck(): Promise<EnvInfo>;
  /** Turn on Canopy's notifications (src/main.mjs notifications:enable). Missing in the design harness. */
  enableNotifications?(): Promise<{ ok: true; pending?: boolean } | { error: string; settings?: boolean }>;
  pickFolder(): Promise<string | null>;
  listSessions(cwd?: string): Promise<SessionSummary[] | { error: string }>;
  listFiles(cwd: string): Promise<string[] | { error: string }>;
  listProjects(): Promise<string[]>;
  pickFiles(cwd?: string): Promise<{ images: ImageAttachment[]; paths: string[] }>;
  /** Where a dropped or pasted file lives on disk (Electron's webUtils), or null when it has none. */
  pathForFile?(file: File): string | null;
  removeProject(dir: string): Promise<string[]>;
  reorderProjects?(dirs: string[]): Promise<string[]>;
  rename(id: string, title: string, cwd?: string): Promise<unknown>;
  mcpStatus(): Promise<{ name: string; status: string }[] | { error: string }>;
  gitInfo(cwd: string): Promise<{ branch: string | null; repo?: string | null; remote?: string | null }>;
  reveal(path: string): Promise<unknown>;
  stopTask?(taskId: string): Promise<{ ok: boolean; message?: string }>;
  chatTotals?(cwd?: string | null, sessionId?: string | null): Promise<{ cost: number; agentCost?: number; workMs: number; linesAdded: number; linesRemoved: number } | null>;
  /** A background agent's steps in words, from its transcript (the agent's id is its task's id). */
  agentSteps?(cwd: string | null, sessionId: string | null, agentId: string): Promise<{ steps: { text: string; at: number | null }[]; total: number; startedAt: number | null; lastAt: number | null; result: string | null } | null>;
  workflowAgents?(cwd?: string | null, sessionId?: string | null): Promise<{ run: string; phases?: string[]; agents: { key: string; label: string; phase: string | null; done: boolean; agentId?: string; result?: string; steps?: number; tool?: string | null; detail?: string; startedAt?: number | null; lastAt?: number | null }[] } | null>;
  openPath(path: string, cwd?: string | null, reveal?: boolean): Promise<{ ok: boolean; missing?: string; error?: string; path?: string }>;
  /** A picture on disk that a step looked at (PNG, JPEG, GIF or WebP, by its bytes); `missing` when it is gone or is not one. */
  readImage?(path: string, cwd?: string | null): Promise<{ mediaType: string; data: string } | { missing: true } | { error: string }>;
  /** A file's Quick Look preview as a PNG data URL, or null when it has none (src/main.mjs). */
  fileThumb?(path: string, cwd?: string | null): Promise<string | null>;
  attach(): Promise<LiveSession | null | { error: string }>;
  /** The chat on screen as the engine has it now (like attach, but nothing is restarted or closed for it). */
  snapshot?(): Promise<LiveSession | null | { error: string }>;
  /** "Show earlier": the turns just older than the ones a very long chat opened with, from where `cursor` says. */
  earlier?(sessionId: string | null, cwd: string | null, cursor: string): Promise<EarlierReply>;
  /** Every reply says which `engine` the chat really runs on: trust it over what was asked for. */
  open(cwd: string, resume: string | null, opts?: OpenOpts): Promise<{ ok?: boolean; sid?: string; engine?: Engine; accountId?: string | null; reused?: boolean; live?: LiveSession; history?: CanopyEvent[]; defaults?: { mode: string }; error?: string;
    /** A Codex chat that another app has open: it is shown, and not started here (lib/held). */
    held?: import('./held').Held | null }>;
  /** The model picker's rows by maker; `onModelsChanged` says either list changed, so ask again. */
  models?(): Promise<ModelGroups>;
  onModelsChanged?(cb: () => void): Unsub;
  /** `id`: the uuid this message gets in the conversation, so its bubble can be edited later. */
  send(text: string, images: ImageAttachment[], id?: string): Promise<{ ok?: boolean; error?: string }>;
  edit?(opts: EditRequest): Promise<EditReply>;
  editPreview?(messageId: string): Promise<EditPreview | { error: string }>;
  queue(text: string, images: ImageAttachment[]): Promise<QueueReply>;
  unqueue(id: number): Promise<QueueReply>;
  requeue?(id: number, to: number): Promise<QueueReply>;
  interrupt(): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
  respond(id: number, answer: Answer): Promise<unknown>;
  /** `limits`: the plan's usage limits, when the chat knows them (an API key has none). */
  context(): Promise<{ totalTokens: number; maxTokens: number; percentage: number; limits?: import('./store').Limit[] } | null>;
  /** How drawing a widget went (did its scripts run), for the tool call that showed it: the engine tells Claude. */
  widgetReport?(toolUseId: string, report: { errors: string[] }): Promise<unknown>;
  /** A screenshot the look tool took in this chat, by its ref (look-3), for a widget to show; null when it is gone. */
  widgetShot?(sessionId: string | null, ref: string): Promise<{ data: string; width: number; height: number; url?: string | null; elements?: { x: number; y: number; w: number; h: number; tag: string; role?: string | null; text?: string | null; selector?: string | null }[] } | null>;
  onEvent(cb: (ev: CanopyEvent) => void): Unsub;
  onChatsStatus?(cb: (list: import('./chats').ChatStatus[]) => void): Unsub;
  onSessionsChanged?(cb: () => void): Unsub;
  onChatsFocus?(cb: (to: { sessionId: string | null; cwd: string | null }) => void): Unsub;
  onChatDone?(cb: (e: { sid?: string }) => void): Unsub;
  onNewChat?(cb: () => void): Unsub;
  onAppError(cb: (msg: string) => void): Unsub;
  onEngineUpdated?(cb: () => void): Unsub;
  chatsList?(): Promise<unknown[]>;
  /** Codex chats another app has open right now, by chat id (lib/held). */
  heldChats?(): Promise<Record<string, import('./held').Held>>;
  onHeldChats?(cb: (held: Record<string, import('./held').Held>) => void): Unsub;
  searchChats?(query: string): Promise<{ sessionId: string; cwd: string; role: 'you' | 'canopy'; at: number; uuid: string | null; snippet: string; match: { from: number; length: number } }[]>;
  homeList?(): Promise<unknown[]>;
  homeDay?(): Promise<HomeDay>;
  onHomeStatus?(cb: (list: unknown[]) => void): Unsub;
  homeRespond?(sid: string, id: number, answer: { action: string }): Promise<unknown>;
  homeStop?(sid: string): Promise<unknown>;
  homeStopTasks?(sid: string, ids: string[]): Promise<unknown>;
  onRestartAsk?(cb: (q: { kind?: 'quit' | 'restart'; busy: number; names?: { title: string; helpers: number; state?: 'working' | 'waiting' }[] }) => void): Unsub;
  onQuitPending?(cb: () => void): Unsub;
  quitCancel?(): void;
  restartChoice?(choice: 'wait' | 'now' | 'cancel'): void;
  /** The Dock badge, as the sidebar counts it (chats waiting on you + unread ones). */
  setBadge?(n: number): void;
  restartApp?(): void;
  /** Main's word on the Update ready card: an update is ready, and a restart waits for chats to finish. */
  restartState?(): Promise<{ ready: boolean; waiting: boolean } | null>;
  restartCancel?(): void;
  /** Tells the window which appearance to use, so native vibrancy matches Canopy's theme, not the OS. */
  setTheme?(pref: 'system' | 'light' | 'dark'): Promise<unknown>;
  /** Usage stats (src/telemetry): counts of what gets used, never content. Main checks every event against the one
   *  list of what may leave the Mac. What comes back is read through lib/telemetry-rules.ts, never trusted as typed. */
  telemetry?: {
    track(event: string, props?: Record<string, string | number | boolean>): Promise<unknown>;
    status(): Promise<unknown>;
    set(patch: { enabled?: boolean; name?: string }): Promise<unknown>;
    /** The last events recorded to be sent, newest first. */
    recent(): Promise<unknown>;
    /** The first-launch notice has been seen. */
    noticeShown(): Promise<unknown>;
    /** The first-launch notice is on screen now. Until it is answered, main sends nothing before it has been up for
     *  ten minutes. (Missing on a main from before this: that one does not wait.) */
    noticeUp?(): Promise<unknown>;
    onStatus(cb: (status: unknown) => void): Unsub;
  };
  /** A Claude sign-in Canopy keeps in a folder of its own. `add` shows Claude Code's own sign-in and answers when it ends. */
  accountFolders?: {
    add(kind?: 'plan' | 'console'): Promise<import('./account-rules').AccountChange>;
    remove(id: string): Promise<import('./account-rules').AccountChange>;
  };
  /** A second Codex login in a folder of its own: Codex's own browser sign-in into it, and removing one added here. */
  codexFolders?: {
    add(): Promise<import('./account-rules').AccountChange>;
    cancel(): Promise<{ ok: boolean }>;
    reopen(): Promise<{ ok: boolean }>;
    remove(id: string): Promise<import('./account-rules').AccountChange>;
    onChanged(cb: (v: { phase: string; message: string | null; busy: boolean }) => void): Unsub;
  };
  /** Canopy's own updates. `installRequired` downloads (if that has not happened), installs and restarts, once no
   *  chat is working; `cancelRequired` stops waiting for that. Restarting for an update that is ready is `restartApp`. */
  appUpdate?: {
    status(): Promise<AppUpdateStatus | { error: string }>;
    check(): Promise<AppUpdateStatus | { error: string }>;
    download(): Promise<AppUpdateStatus | { error: string }>;
    setAuto(on: boolean): Promise<AppUpdateStatus | { error: string }>;
    installRequired(): Promise<AppUpdateStatus | { error: string }>;
    cancelRequired(): Promise<AppUpdateStatus | { error: string }>;
    onStatus(cb: (s: AppUpdateStatus) => void): Unsub;
  };
  upkeep?: {
    status(): Promise<UpkeepStatus | null>;
    /** `which`: 'codex' for Codex's "Check now" and its switch; left out, Claude Code's. */
    check(which?: 'codex'): Promise<UpkeepStatus | null>;
    setAuto(on: boolean, which?: 'codex'): Promise<UpkeepStatus | null>;
    clearDrift(which?: 'codex'): Promise<UpkeepStatus | null>;
    onStatus(cb: (s: UpkeepStatus) => void): Unsub;
  };
  /** What Codex needs before it can use the Mac (src/computer-use.mjs). Missing in a main process from before it. */
  computerUse?: {
    status(): Promise<ComputerUseStatus | null>;
    openPane(key: ComputerUsePane): Promise<{ ok: boolean } | null>;
    /** Turns the feature on in the user's own Codex config, through Codex. Only ever from its button. */
    turnOn(): Promise<{ ok: boolean; status?: ComputerUseStatus | null } | null>;
    openCodexApp(): Promise<{ ok: boolean } | null>;
  };
  /** The logins Canopy found, and which one new chats use. `refresh` asks the tools again (`force`: even if just asked).
   *  `use` chooses the account an engine's new chats start on (null: the login the tool finds); open chats keep theirs.
   *  `addKey` / `replaceKey` hand main a pasted API key, which never comes back: only its last four characters do,
   *  in the list (`keyHint`). `remove` takes away an account added in Canopy, never a login the tool itself holds. */
  /** Your Canopy account: Canopy's own Google sign-in (not Claude Code's or Codex's). Never a token, only who you are. */
  canopyAccount?: {
    get(): Promise<CanopyAccountView | { error: string }>;
    /** Opens Google in the browser; resolves once you're signed in (or it was cancelled / failed). */
    signIn(): Promise<CanopyAccountView | { error: string }>;
    cancel(): Promise<{ ok: boolean }>;
    signOut(): Promise<CanopyAccountView | { error: string }>;
    /** Deletes the Canopy account for good (its row in Canopy's list too), then signs out here. */
    deleteAccount?(): Promise<CanopyAccountView | { error: string }>;
    onChanged(cb: (v: CanopyAccountView) => void): Unsub;
  };
  /** Onboarding's Setting Things Up: installs a missing tool with its maker's installer, then checks again. */
  setup?: {
    install(engine: Engine): Promise<{ ok: true; env: EnvInfo } | { error: string }>;
    /** Whether the Claude / ChatGPT desktop apps are installed (never their logins). */
    apps?(): Promise<{ claude: boolean; chatgpt: boolean } | { error: string }>;
  };
  /** Whether the first run (onboarding, then the tour) is behind you. */
  onboarding?: {
    get(): Promise<{ done: boolean } | { error: string }>;
    done(): Promise<{ ok: boolean }>;
  };
  /** Canopy Kit's switch: guidance new chats get for work the user leaves open. */
  kit?: {
    get(): Promise<{ on: boolean } | { error: string }>;
    set(on: boolean): Promise<{ on: boolean } | { error: string }>;
  };
  /** Canopy Memory: short notes a chat saves for the chats after it, shared by Claude and Codex chats. */
  memory?: {
    /** `bridge`: a Claude chat is also shown Codex's own memory, and a Codex chat Claude Code's. Off until turned on. */
    get(): Promise<{ on: boolean; bridge?: boolean } | { error: string }>;
    set(on: boolean): Promise<{ on: boolean; bridge?: boolean } | { error: string }>;
    bridge?(on: boolean): Promise<{ on: boolean; bridge?: boolean } | { error: string }>;
    list(): Promise<{ notes: MemoryNote[]; folder: string } | { error: string }>;
    /** Where one note stands: there, removed (and still restorable), or brought up to date from an earlier wording. */
    state(id: string): Promise<{ note: MemoryNote | null; removed: boolean; previous: boolean } | { error: string }>;
    edit(id: string, patch: { title?: string; text?: string }): Promise<{ note: MemoryNote | null } | { error: string }>;
    remove(id: string): Promise<{ ok: boolean } | { error: string }>;
    restore(id: string): Promise<{ note: MemoryNote | null } | { error: string }>;
    /** A note a save replaced goes back to its wording before (and forth again). */
    revert(id: string): Promise<{ note: MemoryNote | null } | { error: string }>;
  };
  accounts?: {
    list(): Promise<AccountsState | { error: string }>;
    refresh(force?: boolean): Promise<AccountsState | { error: string }>;
    onChanged(cb: (s: AccountsState) => void): Unsub;
    use?(engine: Engine, id: string | null): Promise<AccountReply>;
    addKey?(engine: Engine, key: string): Promise<AccountReply>;
    replaceKey?(engine: Engine, id: string, key: string): Promise<AccountReply>;
    rename?(engine: Engine, id: string, label: string): Promise<AccountReply>;
    remove?(engine: Engine, id: string): Promise<AccountReply>;
  };
  /** The Usage tab. `get` is asked while the tab is on screen (`open`: it has just come on screen) and answers with what is
   *  known now; anything stale is read again in the background and arrives through `onChanged`. `watch(false)`: the tab
   *  went away, so nothing more is read. */
  usage?: {
    get(opts?: { open?: boolean }): Promise<UsageView | { error: string }>;
    refresh(engine?: Engine): Promise<UsageView | { error: string }>;
    watch(on: boolean): Promise<unknown>;
    onChanged(cb: (v: UsageView) => void): Unsub;
  };
  /** Signing in again, and the question the window asks once per launch (src/signin-ipc.mjs). */
  signin?: {
    /** Waits for the launch's own check. `first`: this launch has not been asked before (the prompt shows once). */
    startCheck(): Promise<{ first: boolean; accounts: AccountsState } | { error: string }>;
    /** Open a sign-in for a listed account, or (no `accountId`) for Claude Code's own login. `onState` says when it is open. */
    begin(opts: { engine: Engine; accountId?: string | null }): Promise<{ ok: boolean; id?: string; code?: string; message?: string; error?: string }>;
    /** The window's terminal is ready: Claude Code's sign-in starts in it. `how.console` switches a new sign-in to the Console or back. */
    attach(id: string, cols: number, rows: number, how?: { console: boolean }): Promise<{ ok: boolean; message?: string; error?: string }>;
    input(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    /** Open in Terminal instead. */
    terminal(id: string): Promise<{ ok: boolean; message?: string; error?: string }>;
    check(id: string): Promise<unknown>;
    cancel(id: string): Promise<unknown>;
    onData(cb: (id: string, data: string) => void): Unsub;
    onState(cb: (s: SignInState) => void): Unsub;
  };
  /** Signing in to Codex: Codex's own sign-in, opened in the browser by main. `signOut` needs `true`, which only the
   *  window's confirmation sends. */
  codexLogin?: {
    state(): Promise<CodexLoginReply>;
    start(): Promise<CodexLoginReply>;
    cancel(): Promise<CodexLoginReply>;
    reopen(): Promise<CodexLoginReply>;
    dismiss(): Promise<CodexLoginReply>;
    signOut(confirmed: true): Promise<{ ok?: boolean; code?: string; message?: string; error?: string }>;
    onChanged(cb: (s: CodexLoginReply) => void): Unsub;
  };
  /** Multi mode: chats in panes, each addressed by its own id (sid) rather than "the chat on screen". */
  pane?: {
    keepAlive?: boolean;
    open(cwd: string, resume: string | null, opts?: OpenOpts): Promise<{ ok?: boolean; sid?: string; engine?: Engine; accountId?: string | null; reused?: boolean; live?: LiveSession; history?: CanopyEvent[]; defaults?: { mode: string }; error?: string;
    /** A Codex chat that another app has open: it is shown, and not started here (lib/held). */
    held?: import('./held').Held | null }>;
    shown(sids: string[], cached?: string[]): Promise<unknown>;
    send(sid: string, text: string, images: ImageAttachment[], id?: string): Promise<{ ok?: boolean; error?: string }>;
    edit?(sid: string, opts: EditRequest): Promise<EditReply>;
    editPreview?(sid: string, messageId: string): Promise<EditPreview | { error: string }>;
    earlier?(sid: string, sessionId: string | null, cwd: string | null, cursor: string): Promise<EarlierReply>;
    queue(sid: string, text: string, images: ImageAttachment[]): Promise<QueueReply>;
    unqueue(sid: string, id: number): Promise<QueueReply>;
    requeue?(sid: string, id: number, to: number): Promise<QueueReply>;
    interrupt(sid: string): Promise<unknown>;
    set(sid: string, key: string, value: unknown): Promise<unknown>;
    respond(sid: string, id: number, answer: Answer): Promise<unknown>;
    context(sid: string): Promise<{ totalTokens: number; maxTokens: number; percentage: number; limits?: import('./store').Limit[] } | null>;
    stopTask(sid: string, taskId: string): Promise<{ ok: boolean; message?: string }>;
    onClosed(cb: (x: { sid: string; sessionId: string | null }) => void): Unsub;
  };
  term: {
    open(cols: number, rows: number): Promise<{ ok?: boolean; sessionId?: string | null; error?: string }>;
    input(data: string): void;
    resize(cols: number, rows: number): void;
    close(): Promise<unknown>;
    onData(cb: (d: string) => void): Unsub;
    onExit(cb: (info: { exitCode: number; sessionId: string | null }) => void): Unsub;
  };
  /** Run in the chat: a shell block from a reply, in a terminal (src/run-ipc.mjs). Missing before a restart. */
  run?: {
    start(id: string, opts: { sid: string | null; cwd: string | null; code: string; cols: number; rows: number }): Promise<{ ok?: boolean; error?: string }>;
    input(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    stop(id: string): Promise<{ ok: boolean }>;
    onData(cb: (x: { id: string; data: string }) => void): Unsub;
    onExit(cb: (x: { id: string; exitCode: number | null; signal: number | string | null }) => void): Unsub;
  };
}

declare global {
  interface Window { canopy: CanopyApi }
}

/** `available` false: this copy of Canopy has no account of its own (a copy built from source). Missing from an older main: it has one. */
export type CanopyAccountView = { available?: boolean; signedIn: boolean; signingIn: boolean; id: string | null; name: string | null; email: string | null; avatar: string | null };
export const api = window.canopy;

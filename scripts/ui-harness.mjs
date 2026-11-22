// The window, without the app: serves the built UI (dist-ui) to a plain browser with a stand-in for the preload
// bridge (`window.canopy`), so the model menu and Settings can be looked at and clicked headlessly. Electron is never
// started, no Claude Code or Codex process runs, and nothing outside this repo is read or written.
//
//   npm run build:ui                              build first: this serves dist-ui as it is
//   node scripts/ui-harness.mjs [--port 5199]     then open http://127.0.0.1:5199/ in a headless browser
//
// To look at a build without replacing dist-ui (while `npm start` is using it, say), build into another folder and
// serve that:
//   npx vite build --outDir /tmp/canopy-ui-mine --emptyOutDir
//   node scripts/ui-harness.mjs --port 5321 --dist /tmp/canopy-ui-mine
//
// What the window sees is chosen in the address, so one server shows every state:
//
//   ?chat=claude|codex       which maker the chat on screen runs on (default claude)
//   &started=1               the chat has a conversation in it (the other maker's rows then open a new chat)
//   &codex=ok|missing|signedout|silent    is Codex there (default ok). ok lists the OpenAI models recorded from a
//                            real Codex (src/core/test/fixtures/codex-meta.jsonl); the others list none
//   &method=apiKey|chatgpt   how Codex is signed in (default apiKey)
//   &claude=none|signedout   none: Claude Code has not listed its models yet. signedout: nobody is signed in to it
//                            (Settings → Claude Code then has no account to list, and offers the sign-in)
//   &held=the Codex app      (with chat=codex&started=1) another app has the chat on screen open: its row says so and
//                            is faded beside an ordinary one, and one line stands in place of the message box. The row
//                            also carries a failed start, as a refused one would leave it: it must show no dot
//   &stats=new|on|off|empty|blocked   usage stats (Settings > Privacy): new shows the first-launch notice, off starts
//                            with the switch off, empty has nothing in "See what's sent", blocked is a copy that can't
//                            send (the notice is owed and must not show). Left out: this main has no usage stats
//   &settings=models         open Settings at that section once the window is up
//   &memory=5                Canopy Memory holds that many notes (Settings > You > Memory lists them; &settings=memory
//                            opens there), and with &started=1 the chat on screen saved two of them (one new, one
//                            that replaced an older note) and removed a third. &memory=0 is an empty memory. Left
//                            out: this main has none. &bridge=1: sharing Claude Code's and Codex's own memory was
//                            turned on (it starts off)
//   &cu=on|off|missing       Computer Use as Settings → Codex shows it (default on)
//   &up=current|updated|behind|updating|failed|manual    what Canopy's upkeep says about Codex's version on that
//                            page (default current); &drift=1 adds two rows to its "Not shown yet" list
//                            (The page's accounts follow &codex and &method: Codex's own login, or none.)
//   &claudeUp=…              the same six, for Claude Code's version on Settings → Claude Code (default current);
//                            &claudeDrift=1 adds the two "Not shown yet" rows there, and &fixups=1 one model that
//                            Canopy offers newer than Claude Code's own menu does
//   &appUpdate=current|ready|offered|downloading|elsewhere|failed|required|requiredDownloading|requiredFailed|requiredElsewhere
//                            Canopy's own updates (src/core/app-update.mjs), as the released app shows them: the row
//                            in Settings > Advanced, the sidebar card, and the "Update required" screen. Left out: this
//                            copy never updates itself (a run from source), and none of that is shown
//   &dev=0                   the window as the released app has it: no Playground, no ?mock=
//   &usage=perUse|unpriced   what the right panel's Usage tab is told (left out: nothing). perUse: a Console sign-in
//                            and an OpenAI API key, both billed per use and both in dollars, on the day counting
//                            began. unpriced: the same some days on, with a Codex model Canopy has no price for
//   &queue=3                 the chat on screen is working, with that many messages waiting behind its turn (drag
//                            one by its arrow to change the order)
//   &theme=dark|light        (default: the browser's)
//   &playground=widgets-next       open a Playground mock
//   &packaged=1              the window as a packaged Canopy has it: no Playground (⌘⇧P, the palette), and ?mock= is ignored
//   &multiCheck=1&turns=60   mode-switch diagnostics with a longer conversation
//   &chats=9                 that many more saved chats in the list (made-up titles, in this project and another), so an
//                            empty Multi mode pane has chats to search and put in it
//   &choices={…}  &models={…}    JSON put in localStorage as `canopy.choices` / `canopy.models` before the window
//                            starts (saved picks, and the menu's four rows as arranged). Left out: both start empty.
//
// In the page, `window.__harness` is there to check what the window did and to push things at it:
//   __harness.calls            every bridge call so far: [{ name, args }]  (`set` calls are the settings a chat was sent)
//   __harness.emit(event)      a chat event, as main would send it
//   __harness.setModels(g)     replace what `models:list` answers ({ claude, openai, codex }) and announce the change
//   __harness.status(list)     the open chats' live status, as main sends it (the sidebar's dots and second lines)
//   __harness.updateReady()    an engine file changed (a run from source): "Update ready" joins the sidebar's cards
//   __harness.appUpdate(patch) change what Canopy's own updater says, as main would (with &appUpdate=…)
//   __harness.fire(ch, …)      any message from main by its stand-in channel ('signin.onState', …)
//   __harness.setHeld(app)     the chat on screen is open in that app now (null: it was closed there), as main says it
//   __harness.data             the rows and the Codex info in use
//
// Example, with any browser or browser-automation tool:
//   open 'http://127.0.0.1:5199/?chat=codex&started=1&theme=dark', click the model chip, and take a screenshot
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexModelInfo } from '../src/core/codex-host.mjs';
import { heldLine, heldText } from '../src/codex-held.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1] ?? null; };
const PORT = Number(option('--port')) || 5199;
const DIST = path.resolve(option('--dist') ?? path.join(ROOT, 'dist-ui'));

// Claude Code's picker as Canopy offers it today (the Fable row already swapped to the name that follows the family).
// Claude Code marks the models that have Fast; Sonnet and Haiku do not.
const CLAUDE = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5) · $5/$25 per Mtok', supportsFastMode: true },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsFastMode: true },
  { value: 'fable[1m]', resolvedModel: 'claude-fable-5-2', displayName: 'Fable', description: 'Fable 5.2 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok', supportsFastMode: true },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks' },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', description: 'Haiku 5.5 · Fastest for quick answers' },
];

/** The OpenAI rows main would hand the window, from the model list recorded off a real Codex. */
function recordedOpenai() {
  const lines = fs.readFileSync(path.join(ROOT, 'src/core/test/fixtures/codex-meta.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const asked = lines.find((l) => l.dir === 'out' && l.msg.method === 'model/list');
  const answer = lines.find((l) => l.dir === 'in' && !l.msg.method && l.msg.id === asked.msg.id);
  return answer.msg.result.data.filter((m) => !m.hidden).map(codexModelInfo).map((m) => ({
    value: m.value, displayName: m.displayName, description: m.description, engine: 'codex', maker: 'openai', supportsEffort: m.supportsEffort,
    supportedEffortLevels: m.supportedEffortLevels, defaultEffort: m.defaultEffort, supportsFastMode: m.supportsFastMode, isDefault: m.isDefault,
  }));
}

// Runs in the page, before the window's own code. Everything it needs comes in as `data`.
function bridge(data) {
  const q = new URLSearchParams(location.search);
  const put = (key, param) => { const v = q.get(param); if (v) { try { JSON.parse(v); localStorage.setItem(key, v); } catch { /* not JSON: leave it */ } } else localStorage.removeItem(key); };
  put('canopy.choices', 'choices');
  put('canopy.models', 'models');
  if (q.get('theme')) localStorage.setItem('canopy.theme', q.get('theme')); else localStorage.removeItem('canopy.theme');
  localStorage.removeItem('canopy.ui');
  if (q.has('playground')) {
    localStorage.setItem('canopy.ui', JSON.stringify({ view: 'playground', sidebar: false }));
    localStorage.setItem('canopy.playground', q.get('playground'));
  }

  const codexState = q.get('codex') || 'ok';
  const groups = {
    claude: q.get('claude') === 'none' ? [] : data.claude,
    openai: codexState === 'ok' ? data.openai : [],
    codex: codexState === 'missing' ? { installed: false, signedIn: null, version: null, method: null }
      : codexState === 'signedout' ? { installed: true, signedIn: false, version: '0.153.4', method: null }
      : codexState === 'silent' ? { installed: true, signedIn: null, version: '0.153.4', method: null }
      : { installed: true, signedIn: true, version: '0.153.4', method: q.get('method') || 'apiKey' },
  };
  const wantCodex = q.get('chat') === 'codex' && groups.openai.length > 0;
  const started = q.get('started') === '1';
  if (wantCodex && !q.get('choices')) localStorage.setItem('canopy.choices', JSON.stringify({ engine: 'codex' }));

  const listeners = {};
  const on = (channel) => (cb) => { (listeners[channel] ??= new Set()).add(cb); return () => listeners[channel].delete(cb); };
  const fire = (channel, ...args) => { for (const cb of listeners[channel] ?? []) cb(...args); };
  const runs = new Map(); // the stand-in runs going: id -> their timers
  const calls = [];
  const sid = 'harness-chat';
  const sessionId = started ? '11111111-2222-4333-8444-555555555555' : null;
  const cwd = '/tmp/harness-project';
  let engine = wantCodex ? 'codex' : 'claude';
  // Open in another app, in main's own words (src/codex-held.mjs): { [chat id]: { app, line, text } }.
  const heldBy = (app) => (app && sessionId ? { [sessionId]: { app, line: data.held.line.replace('{app}', app), text: data.held.text.replace('{app}', app) } } : {});
  let held = wantCodex ? heldBy(q.get('held')) : {};
  const other = { id: '99999999-2222-4333-8444-555555555555', title: 'Fix the flaky upload test', updated: Date.now() - 3600000, branch: 'main', cwd, named: true, engine: 'codex', preview: 'The test waits for the upload to finish now.' };

  // Usage stats, as main would answer (src/telemetry): a status that follows the switch and the name, and the events
  // recorded to be sent, with what the window itself counts added on top as it happens.
  const statsMode = q.get('stats');
  const cantSend = statsMode === 'blocked';
  const stats = {
    enabled: statsMode !== 'off', name: 'Sam Rivera', installId: '5b0c8f4e-7a1d-4c2b-9e3f-1d2a3b4c5d6e', endpoint: true,
    queued: cantSend ? 0 : 3, lastSentAt: cantSend ? null : Date.now() - 120000, noticeShown: statsMode !== 'new' && !cantSend,
    blocked: cantSend ? 'automated' : null, sending: statsMode !== 'off' && !cantSend,
  };
  const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
  const sent = statsMode === 'empty' ? [] : [
    { event: 'reply_finished', ts: minutesAgo(4), props: { engine: 'claude', model: 'claude-opus-5-5', secs: 42.5, tools_n: 6, tools_bash: 2, tools_edit: 3, tools_read: 1, outcome: 'done', background: false } },
    { event: 'widget', ts: minutesAgo(4), props: { kind: 'table', action: 'shown' } },
    { event: 'permission_answered', ts: minutesAgo(5), props: { engine: 'claude', tool_kind: 'bash', answer: 'allow' } },
    { event: 'message_sent', ts: minutesAgo(5), props: { engine: 'claude', model: 'claude-opus-5-5', length: 'medium', images_n: 1, files_n: 0, queued: false } },
    { event: 'chat_started', ts: minutesAgo(7), props: { engine: 'claude', model: 'claude-opus-5-5', mode: 'acceptEdits', effort: 'high', has_folder: true, kind: 'new' } },
    { event: 'extension_added', ts: minutesAgo(40), props: { type: 'connector', name: 'custom' } },
    { event: 'error', ts: minutesAgo(70), props: { where: 'ui', fingerprint: '9f2c41d07ab35e18', type: 'TypeError', message: 'Cannot read properties of undefined (reading <q>)', count: 2 } },
    { event: 'day_summary', ts: minutesAgo(540), props: { date: '2026-11-15', baseline: false, msgs_claude_canopy: 41, chats_claude_canopy: 6, msgs_claude_terminal: 12, chats_claude_terminal: 3, msgs_codex_canopy: 8, chats_codex_canopy: 2, canopy_active_min: 134, canopy_stops: 3, canopy_images: 4, canopy_long_waits: 1, projects_n: 3 } },
    { event: 'app_opened', ts: minutesAgo(542), props: { os_version: '26.1', arch: 'arm64', cc_version: '2.5.0', codex_version: '0.153.4', claude_found: true, claude_signed_in: true, codex_found: true, codex_signed_in: true, first_run: false } },
    { event: 'milestone', ts: minutesAgo(4320), props: { step: 'first_reply' } },
  ];
  const told = (name, args) => calls.push({ name: `telemetry.${name}`, args });
  const statsChanged = (patch) => { Object.assign(stats, patch); fire('telemetry:status', { ...stats }); return { ...stats }; };
  const telemetry = !statsMode ? undefined : {
    track: async (event, props) => { told('track', [event, props]); if (stats.enabled && statsMode !== 'empty') sent.unshift({ event, ts: new Date().toISOString(), props: props ?? {} }); },
    status: async () => ({ ...stats }),
    set: async (patch) => { told('set', [patch]); return statsChanged({ ...(typeof patch?.enabled === 'boolean' && { enabled: patch.enabled, sending: patch.enabled && !cantSend }), ...(typeof patch?.name === 'string' && { name: patch.name.replace(/[^\p{L}\p{M} .'-]/gu, '').trim() }) }); },
    recent: async () => sent.slice(0, 200),
    noticeShown: async () => { told('noticeShown', []); statsChanged({ noticeShown: true }); },
    noticeUp: async () => { told('noticeUp', []); },
    onStatus: on('telemetry:status'),
  };

  const moreTitles = ['Fix the flaky upload test', 'Telemetry events', 'Ship the release notes', 'Find team call files', 'Usage pricing for Codex', 'Onboarding mock', 'Memory notes', 'Sidebar row sizes', 'Steering keeps the turn'];
  const moreChats = Array.from({ length: Math.max(0, Math.min(40, Number(q.get('chats')) || 0)) }, (_, i) => ({
    id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, title: moreTitles[i % moreTitles.length] + (i >= moreTitles.length ? ` ${Math.floor(i / moreTitles.length) + 1}` : ''),
    updated: Date.now() - (i + 1) * 600000, branch: 'main', cwd: i % 3 === 2 ? '/tmp/harness-other' : cwd, named: true,
  }));
  const history = started ? [
    { kind: 'user-text', text: 'Rename the helper and update its two callers.', at: Date.now() - 60000, history: true },
    { kind: 'assistant-text', text: 'Done. The helper is now `readRows`, and both callers use the new name.', at: Date.now() - 50000, history: true },
  ] : [];
  if (started && q.has('turns')) {
    const count = Math.max(1, Math.min(200, Number(q.get('turns')) || 1));
    history.splice(0, history.length, ...Array.from({ length: count }, (_, i) => [
      { kind: 'user-text', text: `Review helper ${i + 1} and its callers.`, at: Date.now() - (count - i) * 60000, history: true },
      { kind: 'assistant-text', text: `### Helper ${i + 1}\n\nThe callers now use \`readRows\`.\n\n- Preserves the existing return type.\n- Handles missing entries.\n\n\`\`\`ts\nexport const readRows = (rows: string[]) => rows.filter(Boolean);\n\`\`\``, at: Date.now() - (count - i) * 60000 + 1000, history: true },
    ]).flat());
  }
  // Canopy Memory (src/core/memory-store.mjs), as main would answer: &memory=N notes, kept here for the page to
  // edit, delete and bring back. The chat on screen saved the first (new) and the second (it replaced a note).
  const memoryNotes = !q.has('memory') ? null : [
    ['me', null, 'Short answers', 'Keep final answers to 3 lines or fewer unless asked for more detail.', 'user-said'],
    ['project', cwd, 'Package manager', 'Uses pnpm, not npm. Run pnpm install and pnpm test:unit.', 'user-said'],
    ['project', cwd, 'Test command', 'Do not run pnpm test here: it includes the e2e suite, which hits staging. Use pnpm test:unit.', 'model-noticed'],
    ['me', null, 'Email sign-off', 'Sign emails as "Sam R." on its own line. No exclamation marks, no opening pleasantries.', 'user-said'],
    ['project', '/tmp/harness-other', 'Releases', 'Releases are cut from main with make ship, which tags and builds. Never by hand.', 'user-said'],
    ['me', null, 'Code comments', 'Do not add explanatory comments or docstrings to code. Keep a comment only when it explains a non-obvious why.', 'user-said'],
  ].slice(0, Math.max(0, Number(q.get('memory')) || 0)).map(([scope, project, title, text, source], i) => ({ id: `note0${i}`, title, text, scope, project, source, engine: i % 2 ? 'codex' : 'claude', created: Date.now() - (i + 1) * 86400000, updated: Date.now() - (i + 1) * 3600000, replaced: i === 1 ? 'Uses npm. Run npm install and npm test.' : null }));
  // A note the chat on screen removed (its forget row offers Undo): in memory's trash, as main keeps it.
  const forgotten = { id: 'note09', title: 'TypeScript first', text: 'Prefers TypeScript over JavaScript for any new file, in any project.', scope: 'me', project: null, source: 'user-said', engine: 'claude', created: Date.now() - 9 * 86400000, updated: Date.now() - 9 * 3600000, replaced: null };
  const memoryTrash = new Map(memoryNotes?.length >= 2 && started ? [[forgotten.id, forgotten]] : []);
  let memoryOn = true;
  let memoryBridge = q.get('bridge') !== '0'; // on unless the user turns it off
  const memory = memoryNotes && {
    get: async () => ({ on: memoryOn, bridge: memoryBridge }), set: async (on) => { memoryOn = !!on; return { on: memoryOn, bridge: memoryBridge }; },
    bridge: async (on) => { memoryBridge = !!on; return { on: memoryOn, bridge: memoryBridge }; },
    list: async () => ({ notes: [...memoryNotes], folder: '/Users/sam/Library/Application Support/Canopy/memory' }),
    state: async (id) => ({ note: memoryNotes.find((n) => n.id === id) ?? null, removed: memoryTrash.has(id), previous: id === 'note01' }),
    edit: async (id, patch) => { const n = memoryNotes.find((x) => x.id === id); if (!n) return { error: 'That note is gone.' }; Object.assign(n, { title: patch.title || n.title, text: patch.text || n.text, source: 'user-said', updated: Date.now() }); return { note: { ...n } }; },
    remove: async (id) => { const i = memoryNotes.findIndex((n) => n.id === id); if (i < 0) return { ok: false }; memoryTrash.set(id, memoryNotes.splice(i, 1)[0]); return { ok: true }; },
    restore: async (id) => { const n = memoryTrash.get(id); if (!n) return { note: null }; memoryTrash.delete(id); memoryNotes.unshift(n); return { note: n }; },
    revert: async (id) => ({ note: memoryNotes.find((n) => n.id === id) ?? null }),
  };
  if (memoryNotes?.length >= 2 && started) {
    const at = Date.now() - 40000;
    history.push(
      { kind: 'user-text', text: 'One thing before we go on: in this repo we use pnpm, not npm. And keep your final answers to 3 lines.', at, history: true },
      { kind: 'tool-start', id: 'toolu_mem1', name: 'mcp__canopy_memory__remember', input: { title: 'Short answers', note: memoryNotes[0].text, scope: 'me', source: 'user-said' }, at: at + 1000, history: true },
      { kind: 'tool-result', id: 'toolu_mem1', content: `Saved to memory [id ${memoryNotes[0].id}]: "Short answers", about the user.`, isError: false, at: at + 1100, history: true },
      { kind: 'tool-start', id: 'toolu_mem2', name: 'mcp__canopy_memory__remember', input: { title: 'Package manager', note: memoryNotes[1].text, scope: 'project', source: 'user-said' }, at: at + 1200, history: true },
      { kind: 'tool-result', id: 'toolu_mem2', content: `Updated in memory [id ${memoryNotes[1].id}]: "Package manager", about this project (harness). It replaced: "${memoryNotes[1].replaced}". It is kept here for every later chat, so do not also write it to a memory file.`, isError: false, at: at + 1300, history: true },
      { kind: 'tool-start', id: 'toolu_mem3', name: 'mcp__canopy_memory__recall', input: { query: 'test command' }, at: at + 1400, history: true },
      { kind: 'tool-result', id: 'toolu_mem3', content: '## Test command [id note02]\nthis project · an earlier chat confirmed it · 2026-11-19\nDo not run pnpm test here.', isError: false, at: at + 1500, history: true },
      { kind: 'assistant-text', text: 'Got it: pnpm from here on, and short answers.', at: at + 2000, history: true },
      { kind: 'turn-end', subtype: 'success', isError: false, at: at + 2100, history: true },
      { kind: 'user-text', text: 'That note about me preferring TypeScript is wrong, I never said that. Get rid of it.', at: at + 3000, history: true },
      { kind: 'tool-start', id: 'toolu_mem4', name: 'mcp__canopy_memory__forget', input: { note: 'TypeScript first' }, at: at + 4000, history: true },
      { kind: 'tool-result', id: 'toolu_mem4', content: `Removed from memory [id ${forgotten.id}]: "${forgotten.title}". It said: "${forgotten.text}". Later chats no longer start with it.`, isError: false, at: at + 4100, history: true },
      { kind: 'assistant-text', text: 'Removed. Later chats will not start with it.', at: at + 5000, history: true },
      { kind: 'turn-end', subtype: 'success', isError: false, at: at + 5100, history: true },
    );
  }
  /** What a chat says about itself once it is open: Claude lists its models, an OpenAI chat names its model and effort. */
  const hello = () => {
    if (engine === 'codex') {
      const row = groups.openai.find((m) => m.isDefault) ?? groups.openai[0];
      fire('session:event', { kind: 'init', sid, engine: 'codex', sessionId, model: row?.value ?? null, effort: row?.defaultEffort ?? null, permissionMode: 'default' });
      fire('session:event', { kind: 'meta', sid, engine: 'codex', sessionId, model: row?.value ?? null, effort: row?.defaultEffort ?? null, commands: [] });
    } else {
      fire('session:event', { kind: 'init', sid, sessionId, model: 'claude-opus-5-5', permissionMode: 'default' });
      fire('session:event', { kind: 'meta', sid, sessionId, models: groups.claude, commands: [] });
    }
  };

  // Nobody signed in to Claude Code now, though a login worked here once: the window opens, as it does in the app.
  const signedOut = q.get('claude') === 'signedout';
  // &queue=N: messages waiting behind a working chat's turn, in the order they go out.
  const queued = Array.from({ length: Number(q.get('queue')) || 0 }, (_, i) => ({ id: i + 1, text: ['also check the restart card', 'then fix the model chip', 'and write the tests', 'ship it'][i % 4], images: [] }));
  let queueV = 1;
  // A screenshot `look` took, for widgets that show one (<canopy-shot>, <canopy-review>): ref "look-demo" is a landing
  // page drawn here on a canvas, with the element map look records; any other ref has no shot, as main would say.
  const demoShot = () => {
    const W = 1280, H = 800;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const elements = [];
    const el = (x, y, w, h, tag, text, role = null, selector = null) => elements.push({ x, y, w, h, tag, role, text, selector });
    g.fillStyle = '#0f1a14'; g.fillRect(0, 0, W, H);
    el(0, 0, W, H, 'body', '');
    g.font = '600 17px -apple-system, system-ui, sans-serif'; g.fillStyle = '#eef5f0'; g.fillText('Canopy', 110, 58); el(110, 40, 70, 24, 'a', 'Canopy', 'link', 'header > a.logo');
    g.font = '17px -apple-system, system-ui, sans-serif'; g.fillStyle = '#a9c4b3';
    [['Features', 930], ['Pricing', 1020], ['Docs', 1100]].forEach(([t, x]) => { g.fillText(t, x, 58); el(x, 40, 70, 24, 'a', t, 'link', `nav a[href="/${t.toLowerCase()}"]`); });
    g.font = '600 76px -apple-system, system-ui, sans-serif'; g.fillStyle = '#eef5f0';
    g.fillText('Calm software for people', 110, 230); g.fillText('who build with AI, every day.', 110, 312);
    el(110, 168, 980, 164, 'h1', 'Calm software for people who build with AI, every day.', null, 'main h1');
    g.font = '24px -apple-system, system-ui, sans-serif'; g.fillStyle = '#a9c4b3'; g.fillText('Every Claude Code and Codex chat in one window.', 110, 380);
    el(110, 356, 560, 32, 'p', 'Every Claude Code and Codex chat in one window.', null, 'main p.lede');
    const pill = (x, w, fill, stroke, text, color) => { g.beginPath(); g.roundRect(x, 420, w, 56, 28); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.stroke(); } g.font = '500 19px -apple-system, system-ui, sans-serif'; g.fillStyle = color; g.fillText(text, x + 28, 455); };
    pill(110, 230, '#eef5f0', null, 'Download for Mac', '#0f1a14'); el(110, 420, 230, 56, 'a', 'Download for Mac', 'button', 'a.download');
    pill(356, 200, null, '#3d5a49', 'Watch the tour', '#eef5f0'); el(356, 420, 200, 56, 'button', 'Watch the tour', null, 'button.tour');
    el(100, 410, 470, 76, 'div', 'Download for Mac Watch the tour', null, 'main .actions');
    ['Triage, not tabs', 'Every account', 'Nothing to learn'].forEach((t, i) => { const x = 110 + i * 360; g.fillStyle = '#16261d'; g.beginPath(); g.roundRect(x, 600, 340, 140, 18); g.fill(); g.font = '20px -apple-system, system-ui, sans-serif'; g.fillStyle = '#eef5f0'; g.fillText(t, x + 26, 646); el(x, 600, 340, 140, 'article', t, null, `.features article:nth-child(${i + 1})`); });
    return { data: c.toDataURL('image/jpeg', 0.9), width: W, height: H, url: 'http://localhost:3000/', elements };
  };
  const known = {
    dev: q.get('dev') !== '0', // the Playground and ?mock= exist only in a run from source
    widgetShot: async (sessionId, ref) => { calls.push({ name: 'widgetShot', args: [sessionId, ref] }); await new Promise((r) => setTimeout(r, 500)); return ref === 'look-demo' ? demoShot() : null; },
    init: async () => ({ claudePath: '/usr/local/bin/claude', version: '2.5.0 (Claude Code)', auth: { loggedIn: !signedOut, method: signedOut ? null : 'claude.ai', org: null }, everSignedIn: true, lastFolder: cwd, userName: 'Sam', chatsDir: '/tmp/harness-chats', home: '/tmp',
      appVersion: '0.0.1', claudeDir: '/Users/sam/.claude', codexDir: '/Users/sam/.codex', codexPath: codexState === 'missing' ? null : '/opt/homebrew/bin/codex', codexVersion: groups.codex.version }),
    recheck: async () => known.init(),
    attach: async () => q.has('playground') || queued.length ? { sid, cwd, engine, sessionId, busy: queued.length > 0, settings: {}, history: [], pending: [], queue: queued, queueV: 1 } : null,
    listSessions: async () => (sessionId ? [{ id: sessionId, title: 'Rename the helper', updated: Date.now(), branch: 'main', cwd, named: true, ...(engine === 'codex' && { engine: 'codex' }) }, ...(q.get('held') ? [other] : []), ...moreChats] : []),
    listProjects: async () => [cwd],
    listFiles: async () => [],
    gitInfo: async () => ({ branch: 'main' }),
    mcpStatus: async () => [],
    // A start Codex refused leaves the chat marked as gone wrong: a row that is held must not show that.
    chatsList: async () => (q.get('held') && sessionId ? [{ sid, sessionId, cwd, state: 'idle', unread: false, helpers: 0, active: true, failed: true, line: 'Codex could not start: thread already has an active writer', engine: 'codex' }] : []),
    heldChats: async () => held,
    onHeldChats: on('codex:held'),
    homeList: async () => [],
    // Home's Today strip: a made-up day, busy now and then from 9 o'clock until now.
    homeDay: async () => {
      const since = new Date().setHours(0, 0, 0, 0), slot = 15 * 60_000;
      const slots = Array.from({ length: 96 }, (_, k) => {
        const at = since + k * slot, on = at < Date.now() && k >= 36 && k % 3 !== 0;
        return on ? { busy: (4 + (k * 7) % 11) * 60_000, cost: 2 + (k % 5) * 1.75, chats: 1 + (k % 3) } : { busy: 0, cost: 0, chats: 0 };
      });
      return { since, slot, busy: slots.reduce((n, x) => n + x.busy, 0), cost: slots.reduce((n, x) => n + x.cost, 0), chats: 11, slots };
    },
    context: async () => null,
    models: async () => groups,
    onModelsChanged: on('models:changed'),
    onEngineUpdated: on('engine:updated'),
    onEvent: on('session:event'),
    // Run in the chat: nothing runs. A run prints what a sign-in would, a line at a time, then ends (exit 0), or
    // exits 1 when the command has "fail" in it. Typing is echoed; Stop ends it at once.
    run: {
      start: async (id, opts) => {
        const lines = ['\x1b[2m$ ' + opts.code + '\x1b[0m', 'Opening your browser to sign in…', 'Waiting for you to authorize…', '\x1b[32m✓\x1b[0m Signed in.'];
        const timers = lines.map((l, i) => setTimeout(() => fire('run:data', { id, data: l + '\r\n' }), 300 + i * 500));
        timers.push(setTimeout(() => { runs.delete(id); fire('run:exit', { id, exitCode: /fail/.test(opts.code) ? 1 : 0, signal: null }); }, 300 + lines.length * 500));
        runs.set(id, timers);
        return { ok: true };
      },
      input: (id, data) => fire('run:data', { id, data: data === '\r' ? '\r\n' : data }),
      resize: () => {},
      stop: async (id) => { (runs.get(id) ?? []).forEach(clearTimeout); runs.delete(id); fire('run:exit', { id, exitCode: 129, signal: 1 }); return { ok: true }; },
      onData: on('run:data'),
      onExit: on('run:exit'),
    },
    open: async (dir, resume, opts) => {
      // A new chat follows the maker asked for, as main does; with no Codex to run it, it is a Claude chat.
      if (!resume && opts && typeof opts === 'object' && 'engine' in opts) engine = opts.engine === 'codex' && groups.openai.length ? 'codex' : 'claude';
      else if (!resume && calls.filter((c) => c.name === 'open').length > 1) engine = 'claude';
      setTimeout(hello, 30);
      return { ok: true, sid, engine, history, defaults: { mode: 'default' }, held: (resume && held[resume]) || null };
    },
    set: async () => ({ ok: true }),
    send: async () => ({ ok: true }),
    queue: async () => ({ ok: true, queue: [], v: 1 }),
    unqueue: async () => ({ ok: true, queue: [], v: 2, removed: true }),
    requeue: async (id, to) => { const i = queued.findIndex((m) => m.id === id); if (i >= 0) { const [m] = queued.splice(i, 1); queued.splice(to, 0, m); } return { ok: true, moved: i >= 0, queue: queued.slice(), v: ++queueV }; },
    setTheme: async () => null,
  };
  // Settings → Codex → Computer use (src/computer-use.mjs), as main would answer: &cu=on|off|missing (default on).
  const cu = q.get('cu') || 'on';
  const cuStatus = () => ({
    installed: cu !== 'missing', version: cu === 'missing' ? null : '26.1111.1001923', on: cu !== 'off', state: cu,
    line: cu === 'on' ? 'On' : cu === 'off' ? 'Turned off in Codex' : 'Not set up yet. Codex installs it the first time you use it in the Codex app.',
    apps: { any: true, listed: [] },
    permissions: [
      { key: 'accessibility', label: 'Accessibility', detail: 'So it can click and type in your apps', needed: true },
      { key: 'screen', label: 'Screen & System Audio Recording', detail: 'So it can see the app it is working in', needed: true },
      { key: 'automation', label: 'Automation', detail: 'Only to send messages you approve', needed: false },
    ],
  });
  const computerUse = { status: async () => cuStatus(), openPane: async () => ({ ok: true }), turnOn: async () => ({ ok: true, status: { ...cuStatus(), on: true, state: 'on', line: 'On' } }), openCodexApp: async () => ({ ok: true }) };
  // Canopy's upkeep (src/core/upkeep.mjs), as main would answer: Codex as &up says, Claude Code as &claudeUp says.
  const upMode = q.get('up') || 'current';
  const checked = Date.now() - 5 * 60000;
  const upkeepOf = (version, mode, { drift = q.get('drift'), needs = '0.160.0', before = '0.152.0' } = {}) => ({
    autoUpdate: mode !== 'manual', blockedBy: null, version, engineVersion: mode === 'behind' ? needs : version, behind: mode === 'behind',
    doing: mode === 'updating' ? 'updating' : null,
    lastCheck: { at: checked, result: mode === 'failed' ? 'failed' : mode === 'updated' ? 'updated' : 'current', version, detail: mode === 'failed' ? 'the download did not finish' : null, reason: 'schedule' },
    lastUpdate: mode === 'updated' ? { at: checked, from: before, to: version } : null,
    fixups: [],
    drift: drift ? [
      { label: 'item/reasoningSummary', keys: ['summary'], version, at: Date.now() - 3 * 3600000, count: 4 },
      { label: 'thread/compacted', keys: [], version, at: Date.now() - 26 * 3600000, count: 1 },
    ] : [],
  });
  // A row Claude Code pins to an older release, and the one Canopy offers instead (src/core/upkeep.mjs `fixups`).
  const fixups = q.get('fixups') ? [{ from: 'claude-fable-5-1', was: '5.1', is: '5.2', to: { value: 'fable[1m]', displayName: 'Fable', resolvedModel: 'claude-fable-5-2' } }] : [];
  let upkeepNow = { ...upkeepOf('2.5.0', q.get('claudeUp') || 'current', { drift: q.get('claudeDrift'), needs: '2.6.0', before: '2.4.0' }), fixups, codex: codexState === 'missing' ? null : upkeepOf('0.153.4', upMode) };
  const quiet = { upkeep: {
    status: async () => upkeepNow, check: async () => upkeepNow, clearDrift: async () => upkeepNow, onStatus: on('upkeep:status'),
    setAuto: async (v, which) => { upkeepNow = which === 'codex' ? { ...upkeepNow, codex: upkeepNow.codex && { ...upkeepNow.codex, autoUpdate: !!v } } : { ...upkeepNow, autoUpdate: !!v }; fire('upkeep:status', upkeepNow); return upkeepNow; },
  } };
  // Canopy's own updates (src/core/app-update.mjs). Pressing a button moves the state on the way main would.
  const mustUpdate = { version: '0.1.2', message: 'This update fixes sign-in. Restart to continue.' };
  const UPDATES = {
    current: {}, ready: { available: '0.1.1', ready: '0.1.1' }, offered: { auto: false, available: '0.1.1' },
    downloading: { available: '0.1.1', state: 'downloading', progress: 0.42 }, elsewhere: { available: '0.1.1', canInstall: false },
    failed: { available: '0.1.1', failed: '0.1.1' },
    required: { available: '0.1.2', ready: '0.1.2', required: mustUpdate },
    requiredDownloading: { available: '0.1.2', state: 'downloading', progress: 0.42, required: mustUpdate },
    requiredFailed: { available: '0.1.2', error: 'OFFLINE', required: mustUpdate },
    requiredElsewhere: { available: '0.1.2', canInstall: false, required: mustUpdate },
  };
  let updateNow = q.get('appUpdate') in UPDATES ? {
    supported: true, off: null, current: '0.1.0', auto: true, state: 'idle', progress: null, available: null, ready: null, required: null, error: null, failed: null,
    canInstall: true, lastCheck: { at: Date.now() - 12 * 60000, result: 'current' }, downloadUrl: 'https://github.com/KrishVazirani18/canopy/releases/latest/download/Canopy.dmg', note: null,
    ...UPDATES[q.get('appUpdate')],
  } : null;
  const setUpdate = (patch) => { updateNow = { ...updateNow, ...patch }; fire('app-update:status', updateNow); return updateNow; };
  if (updateNow) quiet.appUpdate = {
    status: async () => updateNow, onStatus: on('app-update:status'),
    check: async () => { calls.push({ name: 'appUpdate.check', args: [] }); await new Promise((r) => setTimeout(r, 600)); return setUpdate({ lastCheck: { at: Date.now(), result: updateNow.available ? 'available' : 'current' } }); },
    download: async () => { calls.push({ name: 'appUpdate.download', args: [] }); setUpdate({ state: 'downloading', progress: 0.1 }); await new Promise((r) => setTimeout(r, 900)); return setUpdate({ state: 'idle', progress: null, ready: updateNow.available }); },
    setAuto: async (v) => { calls.push({ name: 'appUpdate.setAuto', args: [v] }); return setUpdate({ auto: !!v }); },
    installRequired: async () => { calls.push({ name: 'appUpdate.installRequired', args: [] }); return updateNow.ready ? setUpdate({ state: 'installing' }) : updateNow; },
    cancelRequired: async () => { calls.push({ name: 'appUpdate.cancelRequired', args: [] }); return updateNow; },
  };
  // The accounts (src/core/accounts.mjs): Claude Code's own login, and Codex's own as &codex and &method say.
  const account = (engine, more) => ({ id: `${engine}:default`, engine, kind: 'plan', label: '', email: null, org: null, plan: null, via: null, keyHint: null, state: 'ok', why: null, found: true, ...more });
  const codexOwn = codexState !== 'ok' ? null
    : groups.codex.method === 'chatgpt' ? account('codex', { label: 'ChatGPT Pro', email: 'sam@example.com', plan: 'pro' })
    : account('codex', { kind: 'key', label: 'API key' });
  const accountsNow = {
    active: { claude: null, codex: null }, own: { claude: 'claude:default', codex: codexOwn?.id ?? null }, inUse: { claude: 'claude:default', codex: codexOwn?.id ?? null }, checking: false,
    list: [account('claude', { label: 'Claude Max', email: 'sam@example.com', plan: 'max' }), ...(codexOwn ? [codexOwn] : [])],
  };
  if (signedOut) Object.assign(accountsNow, { list: accountsNow.list.filter((a) => a.engine !== 'claude'), own: { ...accountsNow.own, claude: null }, inUse: { ...accountsNow.inUse, claude: null } });
  const accounts = { list: async () => accountsNow, refresh: async () => accountsNow, onChanged: on('accounts:changed') };
  const codexLogin = {
    state: async () => ({ phase: 'idle', message: null, detail: null, installed: codexState !== 'missing', signedIn: groups.codex.signedIn, canSignIn: codexState === 'signedout', signingOut: false, rev: 1 }),
    onChanged: on('accounts:codex'),
  };
  // The Usage tab (src/core/usage.mjs), as main would answer for two logins billed per use: &usage=perUse|unpriced.
  const usageMode = q.get('usage');
  const midnight = new Date().setHours(0, 0, 0, 0);
  const perUse = (maker, more, count) => ({ engine: maker, account: account(maker, more), shape: 'spend', at: Date.now(), loading: false, error: null, count: { unit: 'usd', ...count } });
  const loose = usageMode === 'unpriced';
  const usageNow = !usageMode ? null : { checking: false, sections: [
    perUse('claude', { kind: 'console', label: 'Console', email: 'sam@example.com' }, { today: 491.42, month: loose ? 2140.5 : 491.42, since: midnight - (loose ? 5 * 86_400_000 : 0), chat: engine === 'claude' ? 675.13 : null }),
    perUse('codex', { kind: 'key', label: 'API key' }, {
      today: 21.37, month: loose ? 84.1 : 21.37, since: midnight - (loose ? 5 * 86_400_000 : 0), chat: engine === 'codex' ? 9.84 : null,
      ...(loose && { unpriced: { today: 1_240_000, month: 3_400_000, chat: engine === 'codex' ? 310_000 : 0, models: ['gpt-7-nova'] } }),
    }),
  ] };
  const usage = { get: async () => usageNow, refresh: async () => usageNow, watch: async () => ({ ok: true }), onChanged: on('usage:changed') };
  const grouped = { accounts, codexLogin, ...(usageNow && { usage }), ...(memory && { memory }) };
  const pane = {
    keepAlive: q.get('keepAlive') !== '0',
    open: async (_dir, resume) => ({ sid, engine, reused: true, live: { sessionId: resume, engine, busy: false, history, settings: { permissionMode: 'default' }, pending: [], queue: [], queueV: 0 } }),
    shown: async () => ({ ok: true }),
    context: async () => null,
    onClosed: on('pane:closed'),
  };
  /** Any call the window makes: the known ones answer like main, a listener is kept, the rest answer nothing. */
  const GROUPS = ['accounts', 'usage', 'signin', 'codexLogin', 'accountFolders', 'codexFolders', 'memory'];
  const stand = (name, target) => new Proxy(target, {
    get(t, key) {
      if (typeof key !== 'string') return undefined;
      if (!name && GROUPS.includes(key)) return (stand[key] ??= stand(key, grouped[key] ?? {})); // main's calls that come in groups: the rest answer nothing
      if (key in quiet && !name) return quiet[key];
      const full = name ? `${name}.${key}` : key;
      if (!(key in t)) {
        if (!name && key === 'computerUse') return (stand[key] ??= stand(key, computerUse));
        if (!name && ['pane', 'term', 'customize'].includes(key)) return (stand[key] ??= stand(key, key === 'pane' ? pane : {})); // one stand-in each, kept: `window.canopy.pane.earlier = async () => …` replaces a call
        t[key] = key.startsWith('on') ? on(full) : async () => null;
      }
      const fn = t[key];
      if (typeof fn !== 'function') return fn;
      return key.startsWith('on') ? fn : (...args) => { calls.push({ name: full, args }); return fn(...args); };
    },
  });
  quiet.telemetry = telemetry;
  window.canopy = stand('', known);
  window.__harness = {
    calls, data: groups,
    emit: (ev) => fire('session:event', { sid, ...ev }),
    setModels: (g) => { Object.assign(groups, g); fire('models:changed'); },
    setHeld: (app) => { held = heldBy(app); fire('codex:held', held); },
    status: (list) => fire('onChatsStatus', list),
    updateReady: () => fire('engine:updated'),
    appUpdate: (patch) => setUpdate(patch),
    /** Any message from main, by the stand-in's channel name (e.g. 'signin.onState'), for showing a state. */
    fire: (channel, ...args) => fire(channel, ...args),
  };
  if (q.has('multiCheck')) window.addEventListener('load', () => {
    const status = document.createElement('output');
    status.style.cssText = 'position:fixed;bottom:0;left:0;z-index:99999;background:#15251c;color:#c6ffdc;padding:5px 12px;font:12px monospace;pointer-events:none';
    document.body.append(status);
    const first = new Map();
    const replacements = new Set();
    let changes = 0;
    let previousMode;
    let lastKeyAt = 0;
    let latency = 0;
    window.addEventListener('keydown', (e) => { if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'm') lastKeyAt = performance.now(); }, true);
    window.addEventListener('pointerdown', () => { lastKeyAt = performance.now(); }, true);
    const update = () => {
      for (const view of document.querySelectorAll('[data-chat-view]')) {
        const textarea = view.querySelector('textarea');
        if (!textarea) continue;
        const key = view.dataset.chatView;
        if (!first.has(key) || !changes) first.set(key, textarea);
        else if (first.get(key) !== textarea) replacements.add(key);
      }
      const mode = !!document.querySelector('[data-chat-view="multi"]:not(.hidden)');
      if (previousMode !== undefined && mode !== previousMode) {
        changes++;
        if (lastKeyAt) latency = Math.round(performance.now() - lastKeyAt);
        lastKeyAt = 0;
      }
      previousMode = mode;
      const text = `Toggles: ${changes} | pane opens: ${calls.filter((c) => c.name === 'pane.open').length} | main opens: ${calls.filter((c) => c.name === 'open').length} | replaced composers: ${[...replacements].join(', ') || 'none'} | toggle commit: ${latency}ms`;
      if (status.textContent !== text) status.textContent = text;
    };
    new MutationObserver(update).observe(document.getElementById('root'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    update();
  });
  const section = q.get('settings');
  if (section) window.addEventListener('load', () => setTimeout(() => window.dispatchEvent(new CustomEvent('canopy:settings', { detail: section })), 1500));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm' };
const data = { claude: CLAUDE, openai: recordedOpenai(), held: { line: heldLine('{app}'), text: heldText('{app}') } };
// "<" is escaped so no row's text can close the script tag it is written into.
const inject = `<script>(${bridge.toString()})(${JSON.stringify(data).replace(/</g, '\\u003c')});</script>`;

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    // A screenshot service captures after page load. Let the app's deliberate one-second startup beat finish in
    // design previews before declaring that load complete (no delay in the app or ordinary harness screens).
    if (url.pathname === '/__preview_ready.gif') {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' }); res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')); }, 1400);
      return;
    }
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.join(DIST, rel);
    if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    if (rel === '/index.html') res.end(fs.readFileSync(file, 'utf8').replace('<head>', `<head>${inject}`)
      .replace('</body>', `${url.searchParams.has('playground') ? '<img hidden alt="" src="/__preview_ready.gif">' : ''}</body>`));
    else fs.createReadStream(file).pipe(res);
  } catch (err) { res.writeHead(500).end(String(err?.message ?? err)); }
});
if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.error(`No built UI in ${DIST}: run \`npm run build:ui\` first`); process.exit(1); }
server.listen(PORT, '127.0.0.1', () => console.log(`Canopy UI harness: http://127.0.0.1:${PORT}/  (Ctrl+C to stop)`));

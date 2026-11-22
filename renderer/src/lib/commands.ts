// Slash commands that Claude Code shows as interactive terminal UI don't work headlessly.
// Canopy intercepts them here and does the native equivalent. Everything else (prompt-style
// commands like /compact, /init, /review, skills, custom commands) passes through to Claude Code.
//
// In an OpenAI chat the same commands drive the same controls: /model finds a name among that maker's models first,
// /effort takes the model's own levels, and the ones that only exist as Claude Code screens say so instead of opening.
// Its /compact, /review and /goal pass through like any message, as in a Claude chat: there the chat's own session
// reads them and makes Codex's call instead of starting a turn (src/core/codex-commands.mjs). Nothing here knows
// which of the two will read a command.
import { toast } from 'sonner';
import { api, type Engine } from './api';
import { choices } from './choices';
import { effortStops, findModel, otherMaker } from './engine-rules';
import { claudeChatsOnly, claudeRows, codexRow, openaiRows } from './engines';
import { store as mainStore, type Store } from './store';
import { feature, setting } from './telemetry';
import { ui } from './ui';
import { modelLabel, setMode } from '@/components/canopy/controls';

const emit = (name: string, detail?: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }));
const control = (key: string, value?: unknown, engine?: Engine) => emit('canopy:control', { key, value, engine });

// Commands that only exist as terminal screens: open the real Claude Code in the Terminal tab and type them there.
const TERMINAL = new Set([
  'config', 'settings', 'login', 'logout', 'doctor', 'checkup', 'agents', 'hooks', 'memory', 'plugin', 'plugins', 'skills',
  'output-style', 'keybindings', 'terminal-setup', 'ide', 'install-github-app', 'install-slack-app', 'privacy-settings',
  'sandbox', 'add-dir', 'rewind', 'checkpoint', 'undo', 'export', 'tasks', 'bashes', 'todos', 'release-notes', 'upgrade',
  'feedback', 'bug', 'copy', 'statusline', 'remote-control', 'rc', 'teleport', 'tp', 'workflows',
]);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODE_ALIASES: Record<string, string> = {
  ask: 'default', default: 'default', manual: 'default', acceptedits: 'acceptEdits', 'auto-edit': 'acceptEdits', autoedit: 'acceptEdits',
  plan: 'plan', auto: 'auto', bypass: 'bypassPermissions', bypasspermissions: 'bypassPermissions',
};

/** The model a typed name means, whose it is, and what to call it. The chat's own maker is looked in first, then the
 *  other, so a name both makers have means the one you are on. No match: the name as typed, for this chat's maker. */
function resolveModel(arg: string, store: Store): { value: string; engine: Engine; label: string } {
  const mine = store.meta.engine;
  if (arg.trim().toLowerCase() === 'default') return { value: '', engine: mine, label: 'the default model' };
  const claude = claudeRows(store.meta), openai = openaiRows();
  const hit = mine === 'codex' ? findModel(arg, openai, claude) : findModel(arg, claude, openai);
  if (!hit) return { value: arg.trim(), engine: mine, label: mine === 'codex' ? arg.trim() : modelLabel(store.meta, arg.trim()) };
  const engine = hit.mine ? mine : otherMaker(mine);
  return { value: hit.row.value, engine, label: engine === 'codex' ? hit.row.displayName || hit.row.value : modelLabel(store.meta, hit.row.value) };
}

/** Returns true if the command was handled natively (don't send it to Claude Code). */
export function runCommand(text: string, ctx: { cwd: string | null; store?: Store }): boolean {
  const store = ctx.store ?? mainStore; // a Multi mode pane passes its own chat's store
  const m = text.trim().match(/^\/([\w:-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return false;
  const name = m[1].toLowerCase();
  const arg = (m[2] ?? '').trim();

  switch (name) {
    case 'model':
      if (!arg) emit('canopy:open-menu', 'model');
      // The other maker's model follows the picker's rule: a started chat stays as it is and a new one opens.
      else { const v = resolveModel(arg, store); feature(v.engine === store.meta.engine ? 'model_changed' : 'engine_changed'); control('model', v.value, v.engine); toast(`Switched to ${v.label}`); }
      return true;
    case 'effort': {
      const a = arg.toLowerCase();
      if (!a || a === 'status') emit('canopy:open-menu', 'model');
      else if (store.meta.engine === 'codex' && !['auto', 'default', 'reset'].includes(a)) {
        // An OpenAI chat: the levels are the model's own. Its "ultra" is one of them; ultracode is Claude Code's.
        const stops = effortStops(codexRow(store.meta));
        if (a.startsWith('ultracode')) claudeChatsOnly(store.meta);
        else if (stops.includes(a)) control('effort', a);
        else toast.error(stops.length ? `“${arg}” isn’t an effort level on this model. Try ${stops.join(', ')}.` : 'This model has no effort levels.');
      }
      else if (a.startsWith('ultracode') || a === 'ultra') control('ultracode', !a.endsWith('off'));
      else if (['auto', 'default', 'reset'].includes(a)) control('effort', '');
      else if (EFFORTS.includes(a)) control('effort', a);
      else { toast.error(`“${arg}” isn’t an effort level. Try low, medium, high, xhigh, max, or ultracode.`); }
      return true;
    }
    case 'ultracode': if (!claudeChatsOnly(store.meta)) control('ultracode', arg ? !/^off$/i.test(arg) : undefined); return true;
    case 'fast': control('fast', arg ? /^on$/i.test(arg) : undefined); return true;
    case 'codemode': case 'code-mode': {
      if (claudeChatsOnly(store.meta)) return true;
      // The choice is for new chats: a chat that has started keeps the tools it started with.
      const on = arg ? /^on$/i.test(arg) : !choices.codeMode;
      if (on && store.meta.codeBlocked) { toast.error(store.meta.codeBlocked); return true; }
      control('codeMode', on);
      setting('code_mode', on);
      toast(on ? 'Code Mode is on for new chats' : 'Code Mode is off for new chats');
      return true;
    }
    case 'clear': case 'reset': case 'new': emit('canopy:new-session'); return true;
    case 'resume': case 'continue': ui.set({ palette: true }); return true;
    case 'permissions': case 'allowed-tools':
      if (arg && MODE_ALIASES[arg.toLowerCase()]) setMode(MODE_ALIASES[arg.toLowerCase()], store);
      else emit('canopy:open-menu', 'mode');
      return true;
    case 'plan':
      setMode('plan', store);
      if (arg) return false; // "/plan <task>": switch to plan mode, then send the task as a normal message
      return true;
    case 'context': case 'cost': case 'stats':
      ui.openTab('stats'); return true;
    case 'usage': ui.openTab('usage'); return true; // the account in use: its plan's limits, or what it has spent
    case 'status': ui.openChatMenu(); return true;
    case 'mcp': if (!arg) { ui.openSettings('connectors'); return true; } break;
    case 'diff': ui.openTab('changes'); return true;
    case 'rename':
      if (arg && store.meta.sessionId) {
        api.rename(store.meta.sessionId, arg, ctx.cwd ?? undefined).then(() => emit('canopy:sessions-changed'));
        feature('chat_renamed');
        toast(`Renamed to “${arg}”`);
      } else toast('Send a message first, then use /rename <title>.');
      return true;
    case 'theme': ui.openSettings(); return true;
    case 'help': setTimeout(() => emit('canopy:prefill', '/')); return true; // after send() clears the box
    case 'exit': case 'quit': toast('Close the window to quit Canopy.'); return true;
  }

  // A custom command or skill with the same name wins (interactive built-ins never appear in meta.commands).
  if (TERMINAL.has(name) && !store.meta.commands.some((c) => c.name.toLowerCase() === name)) {
    if (claudeChatsOnly(store.meta)) return true; // these are Claude Code's own screens
    if (store.meta.busy && !confirm('Canopy is still working. Opening the terminal stops it. Open anyway?')) return true;
    ui.openTab('terminal', { terminalLive: true, terminalCommand: text.trim() });
    return true;
  }
  return false; // passthrough
}

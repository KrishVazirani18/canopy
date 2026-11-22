// Window-level UI state (panels, selection), separate from the conversation store.
import { useSyncExternalStore } from 'react';

export type InspectorTab = 'stats' | 'changes' | 'usage' | 'terminal';
type UiState = {
  sidebar: boolean;
  view: 'chat' | 'home' | 'playground'; // the main area: a chat, Home (the board), or the design Playground
  inspector: boolean;
  tab: InspectorTab;
  focusFile: string | null;
  palette: boolean;
  terminalLive: boolean;
  terminalCommand: string | null; // typed into the real Claude Code once the terminal is up
  updateReady: boolean;   // dev: engine files changed, a restart applies them (sidebar card)
  updateWaiting: boolean; // Restart pressed mid-reply: restart when Claude finishes
  multi: boolean;         // Multi mode: up to four chats side by side (a toggle in the title bar)
};

/** Canopy runs from source (`npm start`), not as a packaged app. The design Playground and `?mock=` exist only there. */
export const fromSource = typeof window !== 'undefined' && window.canopy?.dev === true; // running from source (preload's `dev`)

const saved = (() => { try { return JSON.parse(localStorage.getItem('canopy.ui') ?? '{}'); } catch { return {}; } })();
// A new window (Canopy launched or restarted) opens on Home. A reload of the same window (an update to the window's
// code, or the Playground's own reloads) keeps the view it had: sessionStorage lasts exactly as long as the window.
const freshWindow = (() => { try { if (sessionStorage.getItem('canopy.window')) return false; sessionStorage.setItem('canopy.window', '1'); return true; } catch { return true; } })();
let state: UiState = {
  sidebar: saved.sidebar ?? true,
  // Home and the Playground survive a reload (the Playground has to: every design edit reloads the window); a new
  // window always starts on Home.
  // The Playground exists only when Canopy runs from source.
  view: freshWindow ? 'home' : saved.view === 'home' || (saved.view === 'playground' && window.canopy?.dev) ? saved.view : 'chat',
  inspector: saved.inspector ?? false,
  // The panel tab comes back too (Stats, Changes or Usage). The terminal doesn't: reopening it would start a second Claude Code.
  tab: saved.tab === 'stats' || saved.tab === 'usage' ? saved.tab : 'changes', focusFile: null, palette: false, terminalLive: false, terminalCommand: null, updateReady: false, updateWaiting: false,
  multi: saved.multi === true, // Multi mode survives a reload or restart
};
const listeners = new Set<() => void>();

export const ui = {
  get: () => state,
  set(patch: Partial<UiState>) {
    state = { ...state, ...patch };
    localStorage.setItem('canopy.ui', JSON.stringify({ sidebar: state.sidebar, inspector: state.inspector, tab: state.tab === 'terminal' ? undefined : state.tab, view: state.view, multi: state.multi }));
    for (const l of listeners) l();
  },
  openTab(tab: InspectorTab, extra: Partial<UiState> = {}) { ui.set({ inspector: true, tab, ...extra }); },
  /** The chat menu under the title: context, cost, time and the chat ID (what /context, /cost and /status show). */
  openChatMenu() { window.dispatchEvent(new Event('canopy:chat-menu')); },
  /** Settings, opened at a section (e.g. 'connectors' for /mcp). */
  openSettings(section?: string) { window.dispatchEvent(new CustomEvent('canopy:settings', { detail: section })); },
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
};

export function useUi() {
  return useSyncExternalStore(ui.subscribe, ui.get);
}

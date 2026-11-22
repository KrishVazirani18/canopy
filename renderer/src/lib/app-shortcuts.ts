// The app's keyboard shortcuts (⌘, ⌘K ⌘0 ⌘N ⌘B ⌘I ⌘J ⇧⌘M, and ⇧⌘P from source).
import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { store } from './store';
import { fromSource, ui } from './ui';

const inMulti = () => ui.get().multi;

/**
 * Keyboard shortcuts. Only in the app itself (`inApp`): the loading, setup and welcome screens have none.
 * An open dialog owns the keyboard: ⌘, and ⌘K still work (each closes the other's dialog, and its own
 * when pressed again); the rest wait until it is closed instead of acting behind the scrim.
 */
export function useAppShortcuts({ inApp, newSession, toggleMulti, setSettingsOpen }: {
  inApp: boolean; newSession: () => void; toggleMulti: () => void; setSettingsOpen: Dispatch<SetStateAction<boolean>>;
}) {
  useEffect(() => {
    if (!inApp) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (document.querySelector('[data-update-required]')) return; // "Update required" has the window: nothing opens behind it
      const k = e.key.toLowerCase();
      if (k === ',') { e.preventDefault(); ui.set({ palette: false }); setSettingsOpen((o) => !o); return; }
      if (k === 'k') { e.preventDefault(); setSettingsOpen(false); ui.set({ palette: !ui.get().palette }); return; }
      if (k === 'p' && e.shiftKey && fromSource) { e.preventDefault(); ui.set({ view: ui.get().view === 'playground' ? 'chat' : 'playground' }); return; }
      if (k === '0') { e.preventDefault(); ui.set({ view: ui.get().view === 'home' ? 'chat' : 'home' }); return; }
      if (k === 'm' && e.shiftKey) { e.preventDefault(); if (!document.querySelector('[role="dialog"], [role="alertdialog"]')) toggleMulti(); return; }
      if (k !== 'n' && k !== 'b' && k !== 'i' && k !== 'j') return;
      e.preventDefault();
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (k === 'n') newSession();
      else if (k === 'b') ui.set({ sidebar: !ui.get().sidebar });
      else if (k === 'i') { if (ui.get().view !== 'home' && !inMulti()) ui.set({ inspector: !ui.get().inspector }); }
      else if (inMulti()) return; // the side panel is about one chat: not in Multi mode
      else if (store.meta.engine === 'codex') return; // the terminal is Claude Code's own: an OpenAI chat has none to open
      else { const u = ui.get(); if (u.inspector && u.tab === 'terminal') ui.set({ inspector: false }); else ui.openTab('terminal'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inApp, newSession, toggleMulti, setSettingsOpen]);
}

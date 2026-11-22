// Multi mode: where a chat view sits. A pane that isn't focused must leave window-wide keys and events alone
// (Esc Esc stops only the focused chat, /model changes only its model, ⌘K jumps only into it). Outside Multi mode
// the one chat on screen is always the focused one.
import { createContext, useContext } from 'react';

export type PaneInfo = { multi: boolean; focused: boolean };
export const PaneContext = createContext<PaneInfo>({ multi: false, focused: true });
export const usePane = () => useContext(PaneContext);

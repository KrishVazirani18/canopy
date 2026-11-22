// What widgets remember between visits to a chat: how tall each one was (so a reopened chat reserves its space
// before the frame loads, and nothing jumps), what the user changed in it, and what they answered through it.
// Keyed by the tool call's id, which is unique across chats and survives a fork or a resume. Kept in localStorage,
// newest first; the record of an answer is the user's own message in the transcript, this is only how the widget looks.
const KEY = 'canopy.widgets';
const MAX_ENTRIES = 300;
const MAX_STATE = 8000; // characters of JSON per widget

export type WidgetMemory = { /** Height in px. */ h?: number; /** The widget's own state (frame/runtime.ts). */ s?: unknown; at: number };

let all: Record<string, WidgetMemory> = (() => {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
})();
let timer: ReturnType<typeof setTimeout> | undefined;

function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const ids = Object.keys(all);
    if (ids.length > MAX_ENTRIES) {
      ids.sort((a, b) => (all[b].at ?? 0) - (all[a].at ?? 0));
      all = Object.fromEntries(ids.slice(0, MAX_ENTRIES).map((id) => [id, all[id]]));
    }
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage full: remembered for this run only */ }
  }, 400);
}

export const widgetMemory = {
  get(id: string): WidgetMemory | undefined { return all[id]; },
  /** Remember part of a widget's memory. State too large to be worth keeping is dropped, not truncated. */
  set(id: string, patch: Partial<Omit<WidgetMemory, 'at'>>) {
    if (!id) return;
    if (patch.s !== undefined) { try { if (JSON.stringify(patch.s).length > MAX_STATE) return; } catch { return; } }
    all[id] = { ...all[id], ...patch, at: Date.now() };
    save();
  },
};

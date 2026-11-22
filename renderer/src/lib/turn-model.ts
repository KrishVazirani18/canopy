// The model's name in a finished turn's footer: "Worked for 12s · Done 10:59 PM · Opus 5.5".
//
// `useModelName(id)` turns the model id a turn ended on into the name on screen, for the maker of the chat this
// part of the screen shows, using the same picker rows the model chip uses (model-name.ts has the rule).
// It re-renders when the picker's rows change (a chat reporting its models, a new model arriving), never per
// streamed frame. No id gives '', and the footer then names no model: nothing is guessed.
import { useContext, useSyncExternalStore } from 'react';
import { claudeRows, openaiRows, useModels } from './engines';
import { modelName } from './model-name';
import { StoreContext } from './store';

export function useModelName(id: unknown): string {
  const s = useContext(StoreContext);
  const engine = useSyncExternalStore(s.subscribe, () => s.meta.engine);
  const own = useSyncExternalStore(s.subscribe, () => s.meta.models); // the chat's own Claude rows, when it has reported them
  useModels(); // follow main's lists too: they fill in what the chat has not reported
  return modelName(engine, id, { claude: claudeRows({ models: own }), openai: openaiRows() });
}

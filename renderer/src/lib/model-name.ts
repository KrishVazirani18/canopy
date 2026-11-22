// A model id of either maker as the name on screen: what a finished turn's footer says ran it.
//
//   modelName('claude', 'claude-opus-5-5', lists)   'Opus 5.5'     the picker row whose model it resolves to
//   modelName('codex', 'gpt-6.1-sol', lists)        'GPT-6.1 Sol'  the row's own display name
//   an id no row knows                              the id as it is (a model that was retired, or typed by hand)
//   nothing                                         ''             (the footer then names no model)
//
// The rule for Claude is the one the model chip uses (controls.tsx, `modelLabel`): Claude Code's rows describe
// themselves as "Opus 5.5 · Best for…", or "Use the default model (currently Opus 5.5) · …", and the short name is
// read out of that. A row other than "Default" wins when two rows resolve to the same model.
//
// Nothing here imports anything at run time, reads the window, or throws, so a plain node test runs this file as
// it is (src/core/test/unit/model-name.test.mjs).
import type { ClaudeModel, CodexModel, Engine } from './api';

export type ModelLists = { claude?: readonly ClaudeModel[] | null; openai?: readonly CodexModel[] | null };

/** "Opus 5.5 · Best for…" → "Opus 5.5"; "Use the default model (currently Opus 5.5) · …" → "Opus 5.5". */
export function shortName(m: Pick<ClaudeModel, 'value' | 'displayName' | 'description'>): string {
  const d = typeof m.description === 'string' ? m.description : '';
  const cur = d.match(/currently ([^)]+)\)/);
  if (cur) return cur[1];
  const first = d.split(' · ')[0];
  return first && first.length < 24 ? first : (m.displayName ?? m.value);
}

const rows = <T,>(v: readonly T[] | null | undefined): readonly T[] => (Array.isArray(v) ? v.filter((m) => !!m && typeof (m as { value?: unknown }).value === 'string') : []);

export function modelName(engine: Engine | null | undefined, id: unknown, lists: ModelLists | null | undefined): string {
  if (typeof id !== 'string' || !id.trim()) return '';
  try {
    if (engine === 'codex') {
      const row = rows(lists?.openai).find((m) => m.value === id);
      return (row && typeof row.displayName === 'string' && row.displayName) || id;
    }
    const claude = rows(lists?.claude);
    // What a turn reports is the resolved model ("claude-opus-5-5"); a row's own value ("opus") is found too.
    const row = claude.find((m) => m.resolvedModel === id && m.value !== 'default') ?? claude.find((m) => m.resolvedModel === id) ?? claude.find((m) => m.value === id);
    return row ? shortName(row) : id;
  } catch { return id; }
}

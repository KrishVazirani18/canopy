// Two small things telemetry remembers between launches, beside the queue:
//   - a key/value store (state.json) for whoever needs to remember a date or a flag. The daily summary keeps "the
//     last day sent" here.
//   - the ids of the conversations that are Canopy's (sessions.jsonl), so the daily summary can tell a Canopy chat
//     from a terminal one in the history Claude Code and Codex keep on disk. Ids only: nothing about the chats.
//     Which conversations those are is not decided here: the engine tracker has the one rule (engine.mjs,
//     "conversations Canopy ran": one Canopy has sent a message in, and for Codex only one that began here).
import { jsonFile, ringFile } from './disk.mjs';
import { ENGINES } from './schema.mjs';

const KEY_MAX = 100;

/**
 * A tiny persisted key/value store. `get` and `set` answer from memory at once; saving happens behind them.
 * Values must survive JSON (strings, numbers, booleans, plain objects and arrays); `set(key, undefined)` forgets a key.
 * @param {{ file: string, warn?: (kind: string, err?: unknown) => void }} opts
 */
export function createState({ file, warn = () => {} }) {
  const disk = jsonFile(file, warn);
  let values = Object.create(null); // no inherited keys: a key called "constructor" is just a key
  const validKey = (key) => typeof key === 'string' && key.length > 0 && key.length <= KEY_MAX;
  return {
    /** Read state.json. Anything set before this finished wins over what was on disk. */
    async load() {
      const { status, value } = await disk.read();
      if (status !== 'ok' || !value || typeof value !== 'object' || Array.isArray(value)) return;
      values = Object.assign(Object.create(null), value, values);
    },
    get: (key) => (validKey(key) ? values[key] : undefined),
    set(key, value) {
      if (!validKey(key)) return;
      let json;
      try { json = JSON.stringify(value); } catch { return; } // something JSON can't hold (a cycle): not kept
      if (json === JSON.stringify(values[key])) return;
      if (json === undefined) delete values[key];
      else values[key] = JSON.parse(json); // a copy: later changes to the caller's object don't change what is kept
      disk.write(values);
    },
    settled: () => disk.settled(),
  };
}

export const SESSIONS_MAX = 5000;
// Claude Code and Codex both name a chat with a uuid; anything that isn't id-shaped is not written down.
const SESSION_ID = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * The ids of the conversations that are Canopy's, newest kept, per engine.
 * @param {{ file: string, max?: number, warn?: (kind: string, err?: unknown) => void }} opts
 */
export function createSessionLog({ file, max = SESSIONS_MAX, warn = () => {} }) {
  const valid = (row) => (Array.isArray(row) && ENGINES.includes(row[0]) && typeof row[1] === 'string' && SESSION_ID.test(row[1]) ? [row[0], row[1]] : null);
  const ring = ringFile(file, { max, check: valid, warn });
  const noted = new Set(); // "engine id" of everything pushed or read, so a chat is written down once
  return {
    async load() {
      await ring.load();
      for (const [engine, id] of ring.rows()) noted.add(`${engine} ${id}`);
    },
    /** Remember that this conversation is Canopy's. Returns true the first time. */
    note(engine, id) {
      const row = valid([engine, id]);
      if (!row || noted.has(`${engine} ${id}`)) return false;
      noted.add(`${engine} ${id}`);
      ring.push(row);
      return true;
    },
    /** @returns {{ claude: Set<string>, codex: Set<string> }} fresh sets, the caller's to keep */
    sets() {
      const out = Object.fromEntries(ENGINES.map((e) => [e, new Set()]));
      for (const [engine, id] of ring.rows()) out[engine].add(id);
      return out;
    },
    settled: () => ring.settled(),
  };
}

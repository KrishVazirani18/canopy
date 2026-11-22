// What a chat really cost: the chat itself plus every agent it started (subagents and workflow agents), priced per
// reply from the usage Claude Code logs. The live number from Claude Code covers only replies that finished inside a
// turn, so a workflow that keeps running after the turn ends was missing from it.
//
// Prices are Claude Code's own (its built-in model catalog, $ per million tokens). Fast mode replies (usage.speed
// "fast") cost twice as much. Checked against Claude Code's saved totals: within ~3% (it also counts small side calls
// like titles, which aren't in the transcript), so callers take the larger of this and Claude Code's number.
//
// Files are read incrementally: each one remembers how far it was read, so a long chat costs only its new lines.
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { configHome } from './core/env.mjs';
import { projectFolder } from './core/transcript.mjs';

// $ per million tokens. A cache write is priced at 1.25× the input price (kept 5 minutes) or 2× (kept an hour); a
// cache read at a tenth of it, unless the model lists its own.
const tier = (input, output, cacheRead, extra = {}) => ({ input, output, write5m: input * 1.25, write1h: input * 2, read: cacheRead ?? input / 10, ...extra });
// Most specific first: the first prefix that matches wins.
const PRICES = [
  ['claude-haiku-5-5', tier(0.1, 0.5, 0.01, { long: { above: 100_000, ...tier(0.5, 2.5, 0.05) } })],
  ['claude-haiku-4-5', tier(1, 5)],
  ['claude-3-5-haiku', tier(0.8, 4)],
  ['claude-sonnet-5-5', tier(2, 10, 0.1)],
  ['claude-sonnet-5', tier(2, 10)],
  ['claude-sonnet', tier(3, 15)],
  ['claude-3-7-sonnet', tier(3, 15)],
  ['claude-3-5-sonnet', tier(3, 15)],
  ['claude-opus-5-5', tier(4, 20, 0.2)],
  ['claude-opus-5', tier(5, 25)],
  ['claude-opus-4-0', tier(15, 75)],
  ['claude-opus-4-1', tier(15, 75)],
  ['claude-opus-4', tier(5, 25)],
  ['claude-fable-5-2', tier(8, 40, 0.2)],
  ['claude-fable-5-1', tier(10, 50, 0.25)],
  ['claude-fable-5', tier(10, 50)],
  ['claude-mythos-5-2', tier(8, 40, 0.2)],
  ['claude-mythos-5-1', tier(10, 50, 0.25)],
  ['claude-mythos-5', tier(10, 50)],
];
// A model that is not listed is priced as Opus 5.5.
const FALLBACK = PRICES.find(([k]) => k === 'claude-opus-5-5')[1];
const priceOf = (model) => {
  const id = String(model ?? '').replace(/\[.*\]$/, '');
  return PRICES.find(([k]) => id === k || id.startsWith(k + '-'))?.[1] ?? FALLBACK;
};

/** Dollars for one reply's usage. */
export function replyCost(model, u) {
  if (!u) return 0;
  let p = priceOf(model);
  const prompt = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  if (p.long && prompt > p.long.above) p = p.long;
  const written = u.cache_creation_input_tokens ?? 0;
  const hour = Math.min(written, u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  let usd = ((u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output + (written - hour) * p.write5m + hour * p.write1h
    + (u.cache_read_input_tokens ?? 0) * p.read) / 1e6;
  if (u.speed === 'fast') usd *= 2;             // a Fast reply costs twice as much
  if (u.inference_geo === 'us') usd *= 1.1;     // inference kept in the US is priced 10% higher
  return usd;
}

const files = new Map(); // file -> { size, rest, byId: Map<messageId, usd> }

async function fileCost(file) {
  let st;
  try { st = await stat(file); } catch { return 0; }
  let f = files.get(file);
  if (!f || st.size < f.size) { f = { size: 0, rest: '', byId: new Map() }; files.set(file, f); }
  if (st.size > f.size) {
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - f.size);
      await fh.read(buf, 0, buf.length, f.size);
      const lines = (f.rest + buf.toString('utf8')).split('\n');
      f.rest = lines.pop() ?? ''; // a half-written last line waits for the next read
      f.size = st.size;
      for (const line of lines) {
        if (!line.includes('"usage"') || !line.includes('"type":"assistant"')) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        const m = r.message;
        if (r.type !== 'assistant' || !m?.usage) continue;
        // One reply is logged as several rows (one per block) with the same id; the last one has the final usage.
        f.byId.set(m.id ?? r.uuid, replyCost(m.model, m.usage));
      }
    } finally { await fh.close(); }
  }
  let sum = 0;
  for (const v of f.byId.values()) sum += v;
  return sum;
}

async function agentFiles(dir) {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await agentFiles(p));
    else if (e.name.startsWith('agent-') && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** { chat, agents, total } in dollars, or null if the transcript isn't there. */
export async function chatCost(sessionId, dir, configDir = configHome()) {
  if (!sessionId || !dir || !/^[\w-]+$/.test(String(sessionId))) return null;
  const base = path.join(projectFolder(dir, configDir), sessionId);
  try { await stat(base + '.jsonl'); } catch { return null; }
  const chat = await fileCost(base + '.jsonl');
  let agents = 0;
  for (const f of await agentFiles(path.join(base, 'subagents'))) agents += await fileCost(f);
  return { chat, agents, total: chat + agents };
}

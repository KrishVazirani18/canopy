// The agents inside a running workflow, read from the journal Claude Code keeps for it:
// ~/.claude/projects/<folder>/<session>/subagents/workflows/<wf_…>/journal.jsonl, one line per agent start and result.
// Used by the agents drawer to list a workflow's agents by phase. Read-only, and cheap (journals are small).
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { configHome } from './core/env.mjs';
import { projectFolder } from './core/transcript.mjs';

const MAX_RESULT = 20_000; // per agent, for the detail view
const agentCache = new Map(); // file -> { mtime, info }

/** What one agent is doing, from its own transcript: its latest tool and what it's on, steps so far, start and last times. */
async function agentInfo(file) {
  try {
    const st = await stat(file);
    const hit = agentCache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.info;
    const text = await readFile(file, 'utf8');
    const stamps = [...text.matchAll(/"timestamp":"([^"]+)"/g)];
    const tools = [...text.matchAll(/"type":"tool_use","id":"[^"]*","name":"([^"]+)","input":(\{[^\n]*?\})(?:,"caller"|\})/g)];
    // Its latest real work (the final StructuredOutput call is just the agent handing its answer back).
    const real = tools.filter((t) => t[1] !== 'StructuredOutput');
    const last = real[real.length - 1] ?? tools[tools.length - 1];
    let detail = '';
    if (last) {
      try {
        const i = JSON.parse(last[2]);
        detail = String(i.query ?? i.command ?? i.url ?? i.file_path ?? i.pattern ?? i.description ?? i.prompt ?? '').replace(/\s+/g, ' ').slice(0, 140);
      } catch { /* partial input: name only */ }
    }
    // The model the agent ran on (its replies record it), e.g. claude-fable-5-2.
    const models = [...text.matchAll(/"model":"(claude-[a-z0-9-]+)"/g)];
    const info = {
      model: models.length ? models[models.length - 1][1] : null,
      steps: tools.length,
      tool: last ? last[1] : null, detail,
      startedAt: stamps.length ? Date.parse(stamps[0][1]) : null,
      lastAt: stamps.length ? Date.parse(stamps[stamps.length - 1][1]) : null,
    };
    agentCache.set(file, { mtime: st.mtimeMs, info });
    return info;
  } catch { return null; }
}
/** The phases a workflow declared up front (its script's meta.phases titles), so progress knows the whole plan before
 *  later agents exist. Claude Code saves each run's script as <name>-<run>.js. [] if there's no script or no phases. */
const phaseCache = new Map(); // run -> titles
async function phasesOf(dir, run) {
  if (phaseCache.has(run)) return phaseCache.get(run);
  let titles = [];
  try {
    const file = (await readdir(dir)).find((f) => f.endsWith(`-${run}.js`));
    if (file) {
      const src = await readFile(path.join(dir, file), 'utf8');
      const meta = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
      const list = /phases\s*:\s*\[([\s\S]*?)\]\s*,?\s*$/m.exec(meta)?.[1] ?? /phases\s*:\s*\[([\s\S]*)\]/.exec(meta)?.[1] ?? '';
      titles = [...list.matchAll(/title\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
    }
  } catch { /* no scripts folder */ }
  phaseCache.set(run, titles);
  return titles;
}
const asText = (r) => (typeof r === 'string' ? r : r == null ? '' : JSON.stringify(r, null, 2));

/** @returns {Promise<{ run: string, phases: string[], agents: { key: string, label: string, phase: string | null, done: boolean, agentId?: string, result?: string }[] } | null>} */
export async function workflowAgents(cwd, sessionId, { configDir = configHome() } = {}) {
  if (!cwd || !sessionId || !/^[\w-]+$/.test(String(sessionId))) return null;
  const root = path.join(projectFolder(cwd, configDir), String(sessionId), 'subagents', 'workflows');
  let runs;
  try { runs = (await readdir(root)).filter((d) => d.startsWith('wf_')); } catch { return null; }
  if (!runs.length) return null;
  // The workflow on screen is this chat's most recently active one.
  const stamped = await Promise.all(runs.map(async (r) => ({ r, t: (await stat(path.join(root, r, 'journal.jsonl')).catch(() => null))?.mtimeMs ?? 0 })));
  const run = stamped.sort((a, b) => b.t - a.t)[0].r;
  const text = await readFile(path.join(root, run, 'journal.jsonl'), 'utf8').catch(() => '');
  const byKey = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'started' && e.key) byKey.set(e.key, { ...byKey.get(e.key), key: e.key, label: String(e.label ?? 'agent'), phase: e.phase ?? null, done: byKey.get(e.key)?.done ?? false, agentId: e.agentId });
    else if (e.type === 'result' && e.key) {
      const a = byKey.get(e.key) ?? { key: e.key, label: 'agent', phase: null };
      const text = asText(e.result ?? e.value ?? e.output);
      byKey.set(e.key, { ...a, done: true, result: text.length > MAX_RESULT ? text.slice(0, MAX_RESULT) + '\n…' : text });
    }
  }
  const agents = [...byKey.values()];
  await Promise.all(agents.map(async (a) => { if (a.agentId) Object.assign(a, await agentInfo(path.join(root, run, `agent-${a.agentId}.jsonl`)) ?? {}); }));
  return { run, agents, phases: await phasesOf(path.join(projectFolder(cwd, configDir), String(sessionId), 'workflows', 'scripts'), run) };
}

// ---- one background agent, for its card in the agents drawer ----
const STEP_VERB = { WebSearch: 'Searched', WebFetch: 'Read', Read: 'Read', Grep: 'Searched the code for', Glob: 'Found files', Bash: 'Ran', Edit: 'Edited', MultiEdit: 'Edited', Write: 'Wrote', Task: 'Started an agent', Agent: 'Started an agent', TodoWrite: 'Updated its to-do list' };
const stepDetail = (input) => String(input?.description ?? input?.query ?? input?.url ?? input?.file_path ?? input?.pattern ?? input?.command ?? input?.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
const base = (p) => String(p ?? '').split('/').pop();
/** One step in words: "Read pricing.html", "Ran npm test", "Searched the web for …". */
function stepWords(name, input) {
  if (name === 'WebSearch') return `Searched the web for ${stepDetail(input)}`;
  if (['Read', 'Edit', 'MultiEdit', 'Write'].includes(name)) return `${STEP_VERB[name]} ${base(input?.file_path) || 'a file'}`;
  // A command's description is already a phrase ("Fix last line reference"); a bare command reads "Ran npm test".
  if (name === 'Bash') { const d = String(input?.description ?? '').trim(); return d ? d.slice(0, 120) : `Ran ${stepDetail({ command: input?.command }) || 'a command'}`; }
  if (String(name).startsWith('mcp__')) return `Used ${String(name).split('__')[1] ?? 'a connector'}${stepDetail(input) ? `: ${stepDetail(input)}` : ''}`;
  const verb = STEP_VERB[name] ?? `Used ${name}`;
  const d = stepDetail(input);
  return d && name !== 'TodoWrite' ? `${verb} ${d}` : verb;
}

/**
 * A background agent's steps, from its transcript (<session>/subagents/agent-<id>.jsonl; the id is the task's id).
 * @returns {Promise<{ steps: { text: string, at: number | null }[], total: number, startedAt: number | null, lastAt: number | null, result: string | null } | null>}
 */
export async function agentSteps(cwd, sessionId, agentId, { configDir = configHome(), limit = 300 } = {}) {
  if (!cwd || !/^[\w-]+$/.test(String(sessionId ?? '')) || !/^[\w-]+$/.test(String(agentId ?? ''))) return null;
  const file = path.join(projectFolder(cwd, configDir), String(sessionId), 'subagents', `agent-${agentId}.jsonl`);
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return null; }
  const steps = [];
  let startedAt = null, lastAt = null, result = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const at = Date.parse(row.timestamp ?? '') || null;
    if (at) { startedAt ??= at; lastAt = at; }
    if (row.type !== 'assistant' || !Array.isArray(row.message?.content)) continue;
    for (const b of row.message.content) {
      if (b?.type === 'tool_use' && b.name !== 'StructuredOutput') steps.push({ text: stepWords(b.name, b.input), at });
      if (b?.type === 'text' && b.text?.trim()) result = b.text.trim(); // its last words are its report
    }
  }
  return { steps: steps.slice(-limit), total: steps.length, startedAt, lastAt, result: result ? result.slice(0, 20_000) : null };
}

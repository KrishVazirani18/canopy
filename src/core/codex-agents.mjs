// Sub-agents in an OpenAI chat. Claude Code nests an agent's work under the Agent row that started it and lists the
// agent in the drawer. Codex's agents are threads of their own on the same process: this file keeps, for one chat,
// which child thread belongs to which Agent row, and the same `tasks` list a Claude chat reports.
//
//   const agents = createAgents();
//   agents.noteItem(item)             a `collabAgentToolCall` or `subAgentActivity` item of the chat (or of one of
//                                     its agents: an agent can start agents). True when the task list changed.
//   agents.noteThread(thread)         a `thread/started` thread: a child that names this chat (or a known child) as
//                                     its parent is matched to the oldest "start an agent" call still waiting for one
//   agents.noteLine(id, method, p)    a line from a child thread: its turn, its last step, its end. True on a change.
//   agents.rowOf(id)                  the Agent row a child's work is drawn under, or null (not a known child)
//   agents.has(id)                    is this thread one of the chat's agents
//   agents.turnOf(id)                 { threadId, turnId } of a child's running turn, for Stop; null when not known
//   agents.quiet(ms)                  running children that have said nothing for `ms`: [threadId]
//   agents.tasks()                    the drawer's rows: [{ taskId, status, description, agentType, lastTool,
//                                     toolUseId, startedAt, endedAt, summary }]
//   agents.running()                  how many are running
//   agents.reset()                    forget everything (the chat started over)
//
// Contract: pure, no imports, nothing throws; a thing it cannot read changes nothing. A task's id is its child
// thread's id. Nothing here is in a recording yet (no fixture has an agent): it follows the 0.153.4 protocol types.

const MAX_AGENTS = 64;
const TOOL_NAMES = { commandExecution: 'Bash', fileChange: 'Edit', webSearch: 'WebSearch', imageView: 'Read', mcpToolCall: 'mcp', dynamicToolCall: 'tool', collabAgentToolCall: 'Agent' };
// Codex's word for an agent's state, as a task status the drawer knows.
const STATUS = { pendingInit: 'running', running: 'running', completed: 'completed', errored: 'failed', interrupted: 'stopped', shutdown: 'stopped', notFound: 'failed' };
const ACTIVITY = { started: 'running', interacted: 'running', interrupted: 'stopped', completed: 'completed' };
const HANDS_OVER = new Set(['spawnAgent', 'sendInput', 'sendMessage', 'followupTask', 'resumeAgent']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const firstLine = (s) => { const l = str(s).split('\n').find((x) => x.trim()) ?? ''; const t = l.trim(); return t.length > 160 ? `${t.slice(0, 159)}…` : t; };
const isRunning = (status) => status === 'running' || status === 'pending';

export function createAgents({ now = Date.now } = {}) {
  let agents = new Map();   // child thread id -> record
  let waiting = [];         // "start an agent" calls whose child is not known yet: [{ row, prompt, model, parent }]

  const record = (id) => {
    let a = agents.get(id);
    if (!a) {
      if (agents.size >= MAX_AGENTS) {
        // Room is made by forgetting the oldest agent that is done; one still running is never dropped.
        for (const [k, v] of agents) { if (!isRunning(v.status)) { agents.delete(k); break; } }
        if (agents.size >= MAX_AGENTS) return null;
      }
      a = { id, row: null, prompt: '', model: null, status: 'running', startedAt: now(), endedAt: null, lastTool: null, turnId: null, summary: null, heardAt: null, role: null };
      agents.set(id, a);
    }
    return a;
  };

  const setStatus = (a, status, summary) => {
    let changed = false;
    if (status && a.status !== status) {
      a.status = status;
      a.endedAt = isRunning(status) ? null : a.endedAt ?? now();
      if (!isRunning(status)) a.turnId = null;
      changed = true;
    }
    if (summary && a.summary !== summary) { a.summary = summary; changed = true; }
    return changed;
  };

  function noteCall(item) {
    let changed = false;
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((t) => typeof t === 'string' && t) : [];
    const prompt = str(item.prompt);
    const row = typeof item.id === 'string' && item.id ? item.id : null;
    const hands = HANDS_OVER.has(item.tool) && !!prompt && !!row;
    // A call that hands an agent work has a row of its own: what the agent does next is drawn under it.
    if (hands) {
      for (const id of receivers) {
        const a = record(id);
        if (!a) continue;
        if (a.row !== row) { a.row = row; changed = true; }
        if (item.tool === 'spawnAgent' || !a.prompt) { if (a.prompt !== prompt) { a.prompt = prompt; changed = true; } }
        if (str(item.model) && a.model !== item.model) { a.model = item.model; changed = true; }
        if (item.status === 'inProgress' && setStatus(a, 'running')) changed = true;
      }
      const open = waiting.findIndex((w) => w.row === row);
      if (item.tool === 'spawnAgent' && !receivers.length && item.status === 'inProgress') {
        if (open < 0) waiting.push({ row, prompt, model: str(item.model) || null, parent: str(item.senderThreadId) || null });
      } else if (open >= 0) waiting.splice(open, 1);
      if (waiting.length > MAX_AGENTS) waiting.splice(0, waiting.length - MAX_AGENTS);
    }
    const states = isObj(item.agentsStates) ? item.agentsStates : {};
    for (const [id, st] of Object.entries(states)) {
      const a = agents.get(id);
      if (!a || !isObj(st)) continue;
      const status = STATUS[st.status];
      const done = status && !isRunning(status);
      if (setStatus(a, status, done ? firstLine(st.message) || null : null)) changed = true;
    }
    return changed;
  }

  return {
    noteItem(item) {
      try {
        if (!isObj(item)) return false;
        if (item.type === 'collabAgentToolCall') return noteCall(item);
        if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string' && item.agentThreadId) {
          const known = agents.has(item.agentThreadId);
          const a = record(item.agentThreadId);
          if (!a) return false;
          if (!a.role && str(item.agentPath)) a.role = str(item.agentPath).split('/').filter(Boolean).at(-1) ?? null;
          return setStatus(a, ACTIVITY[item.kind]) || !known;
        }
        return false;
      } catch { return false; }
    },

    noteThread(thread) {
      try {
        if (!isObj(thread) || typeof thread.id !== 'string' || !thread.id || agents.has(thread.id)) return false;
        const spawn = isObj(thread.source) && isObj(thread.source.subAgent) ? thread.source.subAgent.thread_spawn : isObj(thread.source) ? thread.source.thread_spawn : null;
        const parent = str(thread.parentThreadId) || str(spawn?.parent_thread_id);
        if (!parent) return false;
        const at = waiting.findIndex((w) => !w.parent || w.parent === parent);
        if (at < 0) return false;
        const [w] = waiting.splice(at, 1);
        const a = record(thread.id);
        if (!a) return false;
        Object.assign(a, { row: w.row, prompt: w.prompt, model: w.model, role: str(spawn?.agent_role) || str(spawn?.agent_nickname) || null });
        return true;
      } catch { return false; }
    },

    noteLine(id, method, params) {
      try {
        const a = agents.get(id);
        if (!a) return false;
        a.heardAt = now();
        const p = isObj(params) ? params : {};
        if (method === 'turn/started') {
          const turnId = str(p.turn?.id) || null;
          const changed = a.turnId !== turnId || a.status !== 'running';
          a.turnId = turnId;
          setStatus(a, 'running');
          return changed;
        }
        if (method === 'turn/completed') {
          const st = str(p.turn?.status);
          a.turnId = null;
          // The agent's own turn ending is not the agent ending (it can be given more work), except when it failed
          // or was stopped: the call that started it says the rest (`agentsStates`).
          if (st === 'failed') return setStatus(a, 'failed', firstLine(p.turn?.error?.message) || null);
          if (st === 'interrupted') return setStatus(a, 'stopped');
          return false;
        }
        if (method === 'item/started' && isObj(p.item)) {
          const tool = TOOL_NAMES[p.item.type];
          if (!tool) return false;
          const name = tool === 'mcp' ? `mcp__${str(p.item.server) || 'server'}__${str(p.item.tool) || 'tool'}` : tool === 'tool' ? str(p.item.tool) || 'tool' : tool;
          if (a.lastTool === name) return false;
          a.lastTool = name;
          return true;
        }
        return false;
      } catch { return false; }
    },

    rowOf(id) { return agents.get(id)?.row ?? null; },
    has(id) { return agents.has(id); },
    turnOf(id) { const a = agents.get(id); return a && a.turnId ? { threadId: a.id, turnId: a.turnId } : null; },
    quiet(ms) {
      const t = now();
      return [...agents.values()].filter((a) => isRunning(a.status) && a.heardAt === null && t - a.startedAt >= ms).map((a) => a.id);
    },
    running() { let n = 0; for (const a of agents.values()) if (isRunning(a.status)) n++; return n; },
    tasks() {
      return [...agents.values()].map((a) => ({
        taskId: a.id, status: a.status, description: firstLine(a.prompt) || 'Agent', agentType: a.role ?? a.model ?? undefined,
        lastTool: a.lastTool ?? undefined, toolUseId: a.row ?? undefined, startedAt: a.startedAt, endedAt: a.endedAt ?? undefined,
        summary: a.summary ?? undefined, taskType: 'local_agent',
      }));
    },
    /** Every agent still running is marked stopped: the chat's process went away, and they went with it. */
    endAll(status = 'stopped') {
      let changed = false;
      for (const a of agents.values()) if (isRunning(a.status) && setStatus(a, status)) changed = true;
      waiting = [];
      return changed;
    },
    reset() { agents = new Map(); waiting = []; },
  };
}
